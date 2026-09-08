import type { ChunkId, ChunkPriority, ChunkEntry, DataManagerLimits, Chunk } from "./types.js";
import {
  chunkIdToString,
  ChunkState,
  comparePriority,
  reverseComparePriority,
  getMinChunkPriority,
  validateDataManagerLimits,
  DEFAULT_DATA_MANAGER_LIMITS,
  stringToChunkId,
  requestLimitForPriority,
  ChunkPriorityLevel,
  deviceSizeLimitForPriority,
} from "./types.js";
import type { NumberType, TypedArray } from "../types.js";
import PriorityQueue from "./PriorityQueue.js";
import type { DeviceInterface } from "./device_interface.js";
import { ChunkSource, type ExtVolumeDims } from "./sources/ChunkSource.js";
import SlotMap from "./SlotMap.js";

const SUBSCRIBER_ID = Symbol("DataManager.subscriberId");

export interface IDataSubscriber<Tex> {
  [SUBSCRIBER_ID]?: number;
  onChunkLoaded?: (id: ChunkId, chunk: Chunk<NumberType>) => void;
  onChunkOnGpu?: (id: ChunkId, texture: Tex) => void;
  // TODO events for when chunks are evicted?
}

// Subscriber IDs increment globally, like timeout IDs
let subscriberCount = 0;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getIdForSubscriber = (subscriber: IDataSubscriber<any>): number => {
  if (subscriber[SUBSCRIBER_ID] === undefined) {
    subscriber[SUBSCRIBER_ID] = subscriberCount;
    subscriberCount += 1;
  }
  return subscriber[SUBSCRIBER_ID];
};

type SourceEntry<Tex> = {
  source: ChunkSource;
  subscribers: IDataSubscriber<Tex>[];
};

type RequestEntry = {
  chunkKeys: string[];
  controller: AbortController;
};

const swapRemove = <T>(arr: T[], index: number) => {
  if (index < 0) {
    return;
  }

  const { length } = arr;
  const replace = arr.pop();
  if (replace !== undefined && index < length) {
    arr[index] = replace;
  }
};

// TODO also used in `device_interface`; consolidate to utils module or something
const dataTypeToByteLength: { [T in NumberType]: number } = {
  int8: 1,
  int16: 2,
  int32: 4,
  uint8: 1,
  uint16: 2,
  uint32: 4,
  float32: 4,
  float64: 8,
};

type ChunkQueue = PriorityQueue<ChunkPriority, string>;

class ChunkQueues {
  /** Chunks waiting to be loaded */
  load: ChunkQueue = new PriorityQueue(comparePriority);
  /** Chunks in memory that may be evicted */
  evict: ChunkQueue = new PriorityQueue(reverseComparePriority);
  /** Chunks in memory waiting to be uploaded to the GPU */
  deviceLoad: ChunkQueue = new PriorityQueue(comparePriority);
  /** Chunks on the GPU that may be evicted */
  deviceEvict: ChunkQueue = new PriorityQueue(reverseComparePriority);
}

export default class DataManager<Dev, Tex> {
  /** Data and current state for every chunk of data tracked and managed by this class. */
  private chunks = new Map<string, ChunkEntry<Tex>>();
  private queues = new ChunkQueues();
  private sources: SourceEntry<Tex>[] = [];
  /**
   * Information about each in-flight request.
   *
   * This could be stored in `chunks`, but requests don't necessarily correspond one-to-one with chunks.
   */
  private requests = new SlotMap<RequestEntry>();
  /** The amount of chunk data currently cached in memory, in bytes. */
  private memorySize = 0;
  /** The amount of GPU texture memory managed by this class, in bytes. */
  private deviceSize = 0;
  /** A counter for assigning chunks a priority at the `RECENT` level. */
  private recentCounter = 0;

  public limits: DataManagerLimits;

  constructor(
    private deviceInterface: DeviceInterface<Dev, Tex>,
    limits?: Partial<DataManagerLimits>
  ) {
    this.limits = validateDataManagerLimits({
      ...DEFAULT_DATA_MANAGER_LIMITS,
      ...(limits ?? {}),
    });
  }

  // MARK: Helpers

  /**
   * Inserts a chunk into the appropriate queue, or updates its queue position.
   *
   * Assumes that the chunk is not in any queues that don't match its state.
   */
  private updateChunkInQueue(key: string, entry: ChunkEntry<Tex>, noAbort = false) {
    switch (entry.data.state) {
      case ChunkState.QUEUED:
        this.queues.load.insert(key, entry.memoryPriority);
        break;
      case ChunkState.MEMORY:
        this.queues.deviceLoad.insert(key, entry.devicePriority);
        this.queues.evict.insert(key, entry.memoryPriority);
        break;
      case ChunkState.DEVICE:
        this.queues.deviceEvict.insert(key, entry.devicePriority);
        break;
      case ChunkState.LOADING:
        if (entry.memoryPriority.level === ChunkPriorityLevel.RECENT && !noAbort) {
          // TODO cancel request here
        }
        break;
      case ChunkState.WORKER:
    }
  }

  /** Resolves a chunk's overall priority based on all requests for it, then updates its queue position. */
  private updateChunkPriority(key: string, entry: ChunkEntry<Tex>) {
    let nextMemory = getMinChunkPriority();
    let nextDevice = getMinChunkPriority();
    entry.subscriberPriorities.forEach(({ priority, device }) => {
      if (comparePriority(priority, nextMemory) < 0) {
        nextMemory = priority;
      }
      if (device && comparePriority(priority, nextDevice) < 0) {
        nextDevice = priority;
      }
    });

    if (nextMemory.level === ChunkPriorityLevel.RECENT) {
      nextMemory.score = this.recentCounter;
      this.recentCounter += 1;
    }

    if (
      comparePriority(nextMemory, entry.memoryPriority) !== 0 ||
      comparePriority(nextDevice, entry.devicePriority) !== 0
    ) {
      entry.memoryPriority = { ...nextMemory };
      entry.devicePriority = { ...nextDevice };
      this.updateChunkInQueue(key, entry);
    }
  }

  /**
   * Adds an entry for a chunk that has no requests.
   *
   * If we're adding an entry for a chunk that no one asked for, something at least a little unexpected has happened.
   */
  private insertChunkUnprioritized(key: string, data: ChunkEntry<Tex>["data"]): ChunkEntry<Tex> {
    const entry = {
      data,
      subscriberPriorities: [],
      memoryPriority: { level: ChunkPriorityLevel.RECENT, score: this.recentCounter },
      devicePriority: getMinChunkPriority(),
    };
    this.chunks.set(key, entry);
    this.recentCounter += 1;
    this.updateChunkInQueue(key, entry, true);
    return entry;
  }

  private getChunkSpatialDims(chunkId: ChunkId): { x: number; y: number; z: number; dataType: NumberType } | undefined {
    const sourceEntry = this.sources[chunkId.source];
    if (sourceEntry === undefined) {
      return undefined;
    }

    const multiscale = sourceEntry.source.getDims()[chunkId.multiscale];
    if (multiscale === undefined) {
      return undefined;
    }

    // TODO fix config so we don't need this
    // see @typescript-eslint/naming-convention, @typescript-eslint/no-unused-vars
    // eslint-disable-next-line
    const [_t, _c, z, y, x] = multiscale.chunkShape;
    const { dataType } = multiscale;
    return { x, y, z, dataType };
  }

  private estimateChunkSize(chunkId: ChunkId): number {
    // TODO account for edge chunks
    const dims = this.getChunkSpatialDims(chunkId);
    if (dims === undefined) {
      return 0;
    }
    const { x, y, z, dataType } = dims;
    return x * y * z * dataTypeToByteLength[dataType];
  }

  // MARK: Update cycle

  /**
   * Resolves which chunks should be uploaded to the GPU, and which should be evicted from it.
   *
   * In other words, this function drives the `deviceLoad` and `deviceEvict` queues.
   */
  private updateDeviceData(deviceHandle: Dev) {
    // STEP 1: pull eligible chunks out of the `deviceLoad` queue
    const loads: [string, ChunkEntry<Tex>][] = [];
    // This one's easier if we just loop unconditionally and `break` when done.
    while (true) {
      const nextLoad = this.queues.deviceLoad.peek();
      if (nextLoad === undefined) {
        // all out of queued device loads
        break;
      }
      const [loadPriority, loadKey] = nextLoad;

      const loadEntry = this.chunks.get(loadKey);
      // type safety requires these next two `if`s, but neither should be true unless this class has a bug
      if (loadEntry === undefined) {
        console.error(`chunk ${loadKey} queued for device upload without data`);
        this.queues.deviceLoad.pop();
        this.queues.evict.remove(loadKey);
        continue;
      }
      if (loadEntry.data.state !== ChunkState.MEMORY) {
        console.error(
          `chunk ${loadKey} queued for device upload in invalid state (expected "memory", found ${loadEntry.data.state})`
        );
        this.queues.deviceLoad.pop();
        this.queues.evict.remove(loadKey);
        this.updateChunkInQueue(loadKey, loadEntry);
        continue;
      }

      const chunkSize = loadEntry.data.memory.byteLength;
      const nextEvictPriority = this.queues.deviceEvict.peek()?.[0] ?? getMinChunkPriority();
      if (
        // queue this chunk if there's space for it...
        !(this.deviceSize + chunkSize <= deviceSizeLimitForPriority(this.limits, loadPriority)) &&
        // ...or if its priority is greater than the lowest-priority chunk that's already on the GPU.
        // (this implies that at least one chunk will be evicted from the GPU in the next step)
        !(loadPriority.level !== ChunkPriorityLevel.RECENT && comparePriority(loadPriority, nextEvictPriority) < 0)
      ) {
        // otherwise, we're done
        break;
      }

      this.queues.deviceLoad.pop();
      this.queues.evict.remove(loadKey);
      this.queues.deviceEvict.insert(loadKey, loadPriority);
      this.deviceSize += chunkSize;
      loads.push([loadKey, loadEntry]);
    }

    // STEP 2: evict chunks that have been pushed off the GPU
    let nextEvict = this.queues.deviceEvict.peek();
    while (nextEvict !== undefined && this.deviceSize >= deviceSizeLimitForPriority(this.limits, nextEvict[0])) {
      const [evictPriority, evictKey] = nextEvict;
      this.queues.deviceEvict.pop();
      this.queues.deviceLoad.insert(evictKey, evictPriority);
      this.queues.evict.insert(evictKey, evictPriority);

      const evictEntry = this.chunks.get(evictKey);
      if (evictEntry !== undefined) {
        if (evictEntry.data.state === ChunkState.DEVICE) {
          // this chunk was previously on the GPU; demote to `MEMORY` and destroy its texture
          const { memory, dtype } = evictEntry.data;
          this.deviceSize -= memory?.byteLength;
          this.deviceInterface.destroyTexture(evictEntry.data.texture);
          evictEntry.data = { state: ChunkState.MEMORY, memory, dtype };
        } else if (evictEntry.data.state === ChunkState.MEMORY) {
          // this chunk was promoted in the previous step; put it back
          this.deviceSize -= evictEntry.data.memory.byteLength;
          const index = loads.findIndex(([_, entry]) => entry === evictEntry);
          swapRemove(loads, index);
        } else {
          // again, if either of the following errors are ever printed, there's a bug somewhere in this file
          console.error(
            `chunk ${evictKey} queued for device evict in invalid state (expected "device" or "memory", found ${evictEntry.data.state})`
          );
        }
      } else {
        console.error(`chunk ${evictKey} queued for device evict without data`);
      }

      nextEvict = this.queues.deviceEvict.peek();
    }

    // STEP 3: create textures for newly-promoted chunks
    for (const [loadKey, loadEntry] of loads) {
      const loadId = stringToChunkId(loadKey);
      const dims = this.getChunkSpatialDims(loadId);

      if (dims === undefined) {
        console.error(
          `chunk ${loadKey} queued for device upload with invalid source id or multiscale index (id ${loadId.source}, multiscale index ${loadId.multiscale})`
        );
        this.queues.deviceEvict.remove(loadKey);
        this.chunks.delete(loadKey);
        continue;
      }

      const { x, y, z, dataType } = dims;
      const { memory } = loadEntry.data as { memory: TypedArray };
      const texture = this.deviceInterface.createTexture(memory, dataType, [x, y, z], deviceHandle);

      this.sources[loadId.source].subscribers.forEach((s) => s.onChunkOnGpu?.(loadId, texture));

      loadEntry.data = { state: ChunkState.DEVICE, memory, texture, dtype: dataType };
    }

    this.deviceInterface.finishUpdate();
  }

  /**
   * Evicts data cached in memory to stay under the size limit.
   *
   * In other words, this function drives the `evict` queue.
   */
  private evictCachedData() {
    while (this.memorySize > this.limits.size) {
      const nextEvict = this.queues.evict.pop();
      if (nextEvict === undefined) {
        // should never get here (checked above that the chunk isn't larger than the entire cache)
        break;
      }
      const evictKey = nextEvict[1];

      this.queues.deviceLoad.remove(evictKey);
      const evictEntry = this.chunks.get(evictKey);
      // yup... below `if` makes the type system happy, but if they ever evaluate to `true` that's a bug in this class.
      if (evictEntry === undefined) {
        console.error(`chunk ${evictKey} queued for eviction without data`);
        continue;
      }

      switch (evictEntry.data.state) {
        case ChunkState.MEMORY:
          // If we find any state other than this one, it's a bug!
          this.memorySize -= evictEntry.data.memory.byteLength;
          break;
        case ChunkState.DEVICE:
          console.error(`chunk ${evictKey} queued for eviction while in the "device" state`);
          this.deviceSize -= evictEntry.data.memory.byteLength;
          this.memorySize -= evictEntry.data.memory.byteLength;
          this.deviceInterface.destroyTexture(evictEntry.data.texture);
          this.queues.deviceEvict.remove(evictKey);
          // TODO if subscribers get "chunk removed from GPU" events, one should go here
          break;
        case ChunkState.LOADING:
          console.error(`chunk ${evictKey} queued for eviction while in the "loading" state`);
          // TODO cancel request
          break;
        default:
          // TODO `WORKER` state may be weird to manage here
          console.error(
            `chunk ${evictKey} queued for eviction in an invalid state (expected "memory", found ${evictEntry.data.state})`
          );
      }

      this.chunks.delete(evictKey);
    }
  }

  /**
   * Submits requests for chunks that are queued to load.
   *
   * In other words, this function drives the `load` queue.
   */
  private submitRequests() {
    const nextRequest = this.queues.load.peek();
    if (nextRequest === undefined) {
      return;
    }
    let [requestPriority, requestKey] = nextRequest;
    let chunkId = stringToChunkId(requestKey);
    const nextEvictPriority = this.queues.evict.peek()?.[0] ?? getMinChunkPriority();

    while (
      // keep submitting requests while concurrency is available and...
      this.requests.size < requestLimitForPriority(this.limits, requestPriority) &&
      // ...either space will be available or this chunk has higher priority than an already cached chunk
      (this.memorySize + this.estimateChunkSize(chunkId) < this.limits.size ||
        comparePriority(requestPriority, nextEvictPriority) < 0)
    ) {
      // Ignore requests at the `RECENT` level. That's supposed to be for chunks that are already loaded!
      if (requestPriority.level === ChunkPriorityLevel.RECENT) {
        this.queues.load.pop();
        this.chunks.delete(requestKey);
        continue;
      }

      // Get the source that this chunk comes from
      const sourceId = chunkId.source;
      const sourceEntry = this.sources[sourceId];
      if (sourceEntry === undefined) {
        console.error(`chunk ${requestKey} queued for load with invalid source id ${sourceId}`);
        this.queues.load.pop();
        this.chunks.delete(requestKey);
        continue;
      }
      const { source } = sourceEntry;

      // Determine which chunks will be fetched with this request, and set up bookkeeping for the request
      // Accounts for sources that store multiple chunks at the same storage id
      const storageId = source.chunkIdToStorageId(chunkId);
      const chunkIdsAtKey = source.storageIdToChunkIds(storageId);
      const chunkKeys = chunkIdsAtKey.map((id) => chunkIdToString({ ...id, source: sourceId }));
      const controller = new AbortController();
      const requestId = this.requests.insert({ chunkKeys, controller });

      for (const key of chunkKeys) {
        this.queues.load.remove(key);
        const entry = this.chunks.get(key);
        const data = { state: ChunkState.LOADING as const, requestId };
        if (entry === undefined) {
          this.insertChunkUnprioritized(key, data);
        } else if (entry.data.state === ChunkState.QUEUED) {
          entry.data = data;
        }
      }

      // Request the storage key
      sourceEntry.source
        .getKey(storageId, controller.signal)
        .then((chunks) => {
          this.requests.remove(requestId);
          chunks.map((chunk) => this.onChunkLoad(sourceId, chunk));
        })
        .catch(() => {
          this.requests.remove(requestId);
          chunkKeys.map((key) => this.chunks.delete(key));
        });

      const nextRequest = this.queues.load.peek();
      if (nextRequest === undefined) {
        return;
      }
      [requestPriority, requestKey] = nextRequest;
      chunkId = stringToChunkId(requestKey);
    }
  }

  /**
   * Drives progress on all queued requests, including creating textures, evicting data, and submitting requests.
   *
   * Request queueing and submission happen in separate steps to allow all requests to be queued and sorted into
   * priority order before submitting. If requests were submitted immediately upon being added to the queue, the first
   * requests in a batch would submit in the order they were queued, not priority order.
   */
  update(deviceHandle?: Dev) {
    if (this.deviceInterface.isDeviceHandle(deviceHandle)) {
      this.updateDeviceData(deviceHandle);
    }
    this.evictCachedData();
    this.submitRequests();
  }

  private onChunkLoad(source: number, chunk: Chunk<NumberType>) {
    const globalId = { ...chunk.id, source };
    const key = chunkIdToString(globalId);
    const { data: memory, dtype } = chunk;
    if (memory.byteLength > this.limits.size) {
      console.error(`received chunk ${key} which is larger than the cache limit`);
      return;
    }
    const sourceEntry = this.sources[source];
    if (sourceEntry === undefined) {
      console.error(`received chunk ${key} with invalid source id ${source}`);
      return;
    }
    const data = { state: ChunkState.MEMORY as const, memory, dtype };

    let chunkEntry = this.chunks.get(key);
    if (chunkEntry === undefined) {
      console.warn(`received chunk ${key} without data manager entry`);
      chunkEntry = this.insertChunkUnprioritized(key, data);
    } else {
      chunkEntry.data = data;
    }

    this.queues.deviceLoad.insert(key, chunkEntry.memoryPriority);
    this.queues.evict.insert(key, chunkEntry.memoryPriority);

    this.memorySize += memory.byteLength;
    sourceEntry.subscribers.forEach((s) => s.onChunkLoaded?.(globalId, chunk));

    this.update();
  }

  // MARK: Public interface

  /**
   * Declares that subscriber `subscriber` requires chunk `chunkId` at priority level `priority`.
   *
   * If the chunk is not already in memory, this will queue the chunk to be loaded. Chunk load requests are not
   * submitted until the next call to `update`.
   */
  queueChunkRequest(subscriber: IDataSubscriber<Tex>, chunkId: ChunkId, priority: ChunkPriority, device: boolean) {
    const subscriberId = getIdForSubscriber(subscriber);
    const chunkIdString = chunkIdToString(chunkId);
    const chunkEntry = this.chunks.get(chunkIdString);

    if (chunkEntry === undefined) {
      const newChunkEntry: ChunkEntry<Tex> = {
        data: { state: ChunkState.QUEUED },
        subscriberPriorities: [{ subscriberId, priority: { ...priority }, device }],
        memoryPriority: { ...priority },
        devicePriority: device ? { ...priority } : getMinChunkPriority(),
      };
      this.chunks.set(chunkIdString, newChunkEntry);
      this.queues.load.insert(chunkIdString, priority);
    } else {
      const subscriberPriorityIndex = chunkEntry.subscriberPriorities.findIndex(
        (entry) => entry.subscriberId === subscriberId
      );
      if (subscriberPriorityIndex === -1) {
        chunkEntry.subscriberPriorities.push({ subscriberId, priority: { ...priority }, device });
      } else {
        chunkEntry.subscriberPriorities[subscriberPriorityIndex][1] = priority;
      }

      this.updateChunkPriority(chunkIdString, chunkEntry);
    }
  }

  /**
   * Declares that subscriber `subscriber` no longer requires chunk `chunkId`.
   *
   * The `DataManager` will not respond to this change until the next call to `update`.
   */
  removeChunkRequest(subscriber: IDataSubscriber<Tex>, chunkId: ChunkId) {
    const subscriberId = getIdForSubscriber(subscriber);
    const chunkKey = chunkIdToString(chunkId);
    const chunkEntry = this.chunks.get(chunkKey);
    if (chunkEntry === undefined) {
      return;
    }

    const index = chunkEntry.subscriberPriorities.findIndex((entry) => entry.subscriberId === subscriberId);
    if (index < 0) {
      return;
    }

    swapRemove(chunkEntry.subscriberPriorities, index);
    this.updateChunkPriority(chunkKey, chunkEntry);
  }

  /** Get a chunk's data buffer, if it is in memory. */
  getChunkBuffer(chunkId: ChunkId): TypedArray<NumberType> | undefined {
    const key = chunkIdToString(chunkId);
    const entry = this.chunks.get(key);
    if (entry === undefined) {
      return undefined;
    }

    if (entry.data.state === ChunkState.MEMORY || entry.data.state === ChunkState.DEVICE) {
      return entry.data.memory;
    }

    return undefined;
  }

  /** Get a chunk's texture, if it is on the GPU. */
  getChunkTexture(chunkId: ChunkId): Tex | undefined {
    const key = chunkIdToString(chunkId);
    const entry = this.chunks.get(key);
    if (entry?.data.state === ChunkState.DEVICE) {
      return entry.data.texture;
    }
    return undefined;
  }

  /**
   * Add a chunk source to this data manager.
   *
   * Returns the ID that will be used to identify this source in chunk requests and event subscriptions.
   */
  addSource(source: ChunkSource): number {
    const id = this.sources.length;
    this.sources.push({ source, subscribers: [] });
    return id;
  }

  /** Returns the dimensions of the given source. */
  getSourceDims(sourceId: number): ExtVolumeDims[] | undefined {
    return this.sources[sourceId]?.source.getDims();
  }

  /** Subscribes `subscriber` to data events from the source with id `sourceId` */
  subscribeToSource(subscriber: IDataSubscriber<Tex>, sourceId: number): boolean {
    const sourceEntry = this.sources[sourceId];
    if (sourceEntry === undefined) {
      return false;
    }

    if (sourceEntry.subscribers.findIndex((s) => s === subscriber) === -1) {
      sourceEntry.subscribers.push(subscriber);
    }

    return true;
  }

  /** Unsubscribes `subscriber` from data events from the source with id `sourceId` */
  unsubscribeFromSource(subscriber: IDataSubscriber<Tex>, sourceId: number): boolean {
    const sourceEntry = this.sources[sourceId];
    if (sourceEntry === undefined) {
      return false;
    }

    const subscriberIndex = sourceEntry.subscribers.findIndex((s) => s === subscriber);
    if (subscriberIndex > -1) {
      sourceEntry.subscribers.splice(subscriberIndex, 1);
      return true;
    }
    return false;
  }
}
