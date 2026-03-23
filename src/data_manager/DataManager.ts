import {
  ByteType,
  Data3DTexture,
  FloatType,
  IntType,
  PixelFormatGPU,
  RedFormat,
  RedIntegerFormat,
  ShortType,
  TypedArray,
  UnsignedByteType,
  UnsignedIntType,
  UnsignedShortType,
} from "three";

import type { ChunkId, ChunkPriority, ChunkEntry, DataManagerLimits, LocalChunkId } from "./types.js";
import {
  chunkIdToString,
  ChunkState,
  chunkPriorityGreater,
  chunkPriorityLess,
  MIN_CHUNK_PRIORITY,
  validateDataManagerLimits,
  DEFAULT_DATA_MANAGER_LIMITS,
  stringToChunkId,
  requestLimitForPriority,
  ChunkPriorityLevel,
  deviceSizeLimitForPriority,
} from "./types.js";
import { PriorityQueue } from "./PriorityQueue.js";
import { VolumeDims } from "../VolumeDims.js";
import { NumberType } from "../types.js";

export interface IChunkSource {
  getDims(): VolumeDims[];
  getChunk(id: LocalChunkId, signal?: AbortSignal): Promise<TypedArray>;
}

export interface IDataSubscriber {
  // eslint-disable-next-line @typescript-eslint/naming-convention
  _subscriberId?: number;
  onChunkLoaded?: (id: ChunkId) => void;
  onChunkOnDevice?: (id: ChunkId) => void;
}

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

// TODO this should go in a utils module somewhere
const dataTypeToTextureProperties: { [T in Exclude<NumberType, "float64">]: [number, number, PixelFormatGPU] } = {
  int8: [ByteType, RedIntegerFormat, "R8I"],
  int16: [ShortType, RedIntegerFormat, "R16I"],
  int32: [IntType, RedIntegerFormat, "R32I"],
  uint8: [UnsignedByteType, RedIntegerFormat, "R8UI"],
  uint16: [UnsignedShortType, RedIntegerFormat, "R16UI"],
  uint32: [UnsignedIntType, RedIntegerFormat, "R32UI"],
  float32: [FloatType, RedFormat, "R32F"],
};

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
  load: ChunkQueue = new PriorityQueue(chunkPriorityGreater);
  /** Chunks in memory that may be evicted */
  evict: ChunkQueue = new PriorityQueue(chunkPriorityLess);
  /** Chunks in memory waiting to be uploaded to the GPU */
  deviceLoad: ChunkQueue = new PriorityQueue(chunkPriorityGreater);
  /** Chunks on the GPU that may be evicted */
  deviceEvict: ChunkQueue = new PriorityQueue(chunkPriorityLess);
}

export class DataManager {
  /** Data and current state for every chunk of data tracked and managed by this class. */
  private chunks = new Map<string, ChunkEntry>();
  private queues = new ChunkQueues();
  private sources: IChunkSource[] = [];
  /**
   * Information about each in-flight request.
   *
   * This could be stored in `chunks`, but requests don't necessarily correspond one-to-one with chunks.
   */
  private requests = new Map<string, AbortController>();
  /** The amount of chunk data currently cached in memory, in bytes */
  private memorySize = 0;
  /** The amount of GPU texture memory managed by this class, in bytes */
  private deviceSize = 0;
  /** A counter for assigning chunks a priority at the `RECENT` level. */
  private recentCounter = 0;
  /** A counter for assigning subscriber IDs. */
  private subscriberCount = 0;

  public limits: DataManagerLimits;

  constructor(limits?: Partial<DataManagerLimits>) {
    this.limits = validateDataManagerLimits({
      ...DEFAULT_DATA_MANAGER_LIMITS,
      ...(limits ?? {}),
    });
  }

  /** Gets the id of data subscriber `subscriber`, assigning it one if it doesn't have one. */
  private getIdForSubscriber(subscriber: IDataSubscriber): number {
    if (subscriber._subscriberId === undefined) {
      subscriber._subscriberId = this.subscriberCount;
      this.subscriberCount += 1;
    }
    return subscriber._subscriberId;
  }

  /**
   * Inserts a chunk into the appropriate queue, or updates its queue position.
   *
   * Assumes that the chunk is not in any queues that don't match its state.
   */
  private updateChunkInQueue(key: string, entry: ChunkEntry) {
    switch (entry.data.state) {
      case ChunkState.QUEUED:
        this.queues.load.insert(key, entry.priority);
        break;
      case ChunkState.MEMORY:
        this.queues.deviceLoad.insert(key, entry.priority);
        this.queues.evict.insert(key, entry.priority);
        break;
      case ChunkState.DEVICE:
        this.queues.deviceEvict.insert(key, entry.priority);
        break;
      case ChunkState.LOADING:
        if (entry.priority.level === ChunkPriorityLevel.RECENT) {
          // TODO cancel request here
        }
        break;
      case ChunkState.WORKER:
    }
  }

  /** Resolves a chunk's overall priority based on all requests for it, then updates its queue position. */
  private updateChunkPriority(key: string, entry: ChunkEntry) {
    const nextPriority = entry.subscriberPriorities.reduce((prevPriority, [_, priority]) => {
      return chunkPriorityGreater(priority, prevPriority) ? priority : prevPriority;
    }, MIN_CHUNK_PRIORITY);

    if (nextPriority.level === ChunkPriorityLevel.RECENT) {
      nextPriority.score = this.recentCounter;
      this.recentCounter += 1;
    }

    if (nextPriority.level !== entry.priority.level || nextPriority.score !== entry.priority.score) {
      this.updateChunkInQueue(key, entry);
    }
  }

  private getChunkSpatialDims(chunkId: ChunkId): { x: number; y: number; z: number; dataType: NumberType } | undefined {
    const source = this.sources[chunkId.source];
    if (source === undefined) {
      return undefined;
    }

    const multiscale = source.getDims()[chunkId.multiscale];
    if (multiscale === undefined) {
      return undefined;
    }

    // TODO fix config so we don't need this
    // see @typescript-eslint/naming-convention, @typescript-eslint/no-unused-vars
    // eslint-disable-next-line
    const [_t, _c, z, y, x] = multiscale.spacing;
    const { dataType } = multiscale;
    return { x, y, z, dataType };
  }

  private estimateChunkSize(chunkId: ChunkId): number {
    const dims = this.getChunkSpatialDims(chunkId);
    if (dims === undefined) {
      return 0;
    }
    const { x, y, z, dataType } = dims;
    return x * y * z * dataTypeToByteLength[dataType];
  }

  /**
   * Submits queued chunk requests.
   *
   * Request queueing and submission happen in separate steps to allow all requests to be queued and sorted into
   * priority order before submitting. If requests were submitted immediately upon being added to the queue, the first
   * requests in a batch would submit in the order they were queued, not priority order.
   */
  submitRequests() {
    const nextRequest = this.queues.load.peek();
    if (nextRequest === undefined) {
      return;
    }
    let [requestPriority, requestKey] = nextRequest;
    let requestId = stringToChunkId(requestKey);
    const nextEvictPriority = this.queues.evict.peek()?.[0] ?? MIN_CHUNK_PRIORITY;

    while (
      // keep submitting requests while concurrency is available and...
      this.requests.size < requestLimitForPriority(this.limits, requestPriority) &&
      // ...either space will be available or this chunk has higher priority than an already cached chunk
      (this.memorySize + this.estimateChunkSize(requestId) < this.limits.size ||
        chunkPriorityGreater(requestPriority, nextEvictPriority))
    ) {
      this.queues.load.pop();

      if (requestPriority.level === ChunkPriorityLevel.RECENT) {
        // Ignore requests at the `RECENT` level. That's supposed to be for chunks that are already loaded!
        this.chunks.delete(requestKey);
        continue;
      }

      const chunkEntry = this.chunks.get(requestKey);
      if (chunkEntry === undefined) {
        continue;
      }
      chunkEntry.data = { state: ChunkState.LOADING };

      const source = this.sources[requestId.source];
      const abortController = new AbortController();
      this.requests.set(requestKey, abortController);

      source
        .getChunk(requestId, abortController.signal)
        .then((data) => this.onChunkLoad(requestId, data))
        .catch(() => {
          this.chunks.delete(requestKey);
          this.requests.delete(requestKey);
        });

      const nextRequest = this.queues.load.peek();
      if (nextRequest === undefined) {
        return;
      }
      [requestPriority, requestKey] = nextRequest;
      requestId = stringToChunkId(requestKey);
    }
  }

  /** Resolves which chunks should be uploaded to the GPU, and which should be evicted. */
  private updateDeviceData() {
    // STEP 1: pull eligible chunks out of the `deviceLoad` queue
    const loads: [string, ChunkEntry][] = [];
    // Sorry eslint! This one's just easier if we loop unconditionally and break when done.
    // eslint-disable-next-line no-constant-condition
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
      const nextEvictPriority = this.queues.deviceEvict.peek()?.[0] ?? MIN_CHUNK_PRIORITY;
      if (
        // queue this chunk if there's space for it...
        !(this.deviceSize + chunkSize <= deviceSizeLimitForPriority(this.limits, loadPriority)) &&
        // ...or if its priority is greater than the lowest-priority chunk that's already on the GPU.
        // (this implies that at least one chunk will be evicted from the GPU in the next step)
        !(loadPriority.level !== ChunkPriorityLevel.RECENT && chunkPriorityGreater(loadPriority, nextEvictPriority))
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
          const memory = evictEntry.data.texture.image.data;
          this.deviceSize -= memory.byteLength;
          evictEntry.data.texture.dispose();
          evictEntry.data = { state: ChunkState.MEMORY, memory };
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
      const [texType, texFormat, texInternalFormat] = dataTypeToTextureProperties[dataType];
      const data = (loadEntry.data as { memory: TypedArray }).memory.buffer as ArrayBuffer;

      const texture = new Data3DTexture(data, x, y, z);
      texture.type = texType;
      texture.format = texFormat;
      texture.internalFormat = texInternalFormat;
      texture.needsUpdate = true;

      loadEntry.data = { state: ChunkState.DEVICE, texture };
    }
  }

  private onChunkLoad(id: ChunkId, data: TypedArray) {
    // If this just freed up our request quota, make sure to fill it back up
    this.requests.delete(chunkIdToString(id));
    this.submitRequests();
  }

  /**
   * Declares that subscriber `subscriber` requires chunk `chunkId` at priority level `priority`.
   *
   * If the chunk is not already in memory, this will queue the chunk to be loaded. Chunk load requests are not
   * guaranteed to submit until the next call to `submitRequests`.
   */
  queueChunkRequest(subscriber: IDataSubscriber, chunkId: ChunkId, priority: ChunkPriority) {
    const subscriberId = this.getIdForSubscriber(subscriber);
    const chunkIdString = chunkIdToString(chunkId);
    let chunkEntry = this.chunks.get(chunkIdString);

    if (chunkEntry === undefined) {
      chunkEntry = {
        data: { state: ChunkState.QUEUED },
        subscriberPriorities: [[subscriberId, priority]],
        priority: priority,
      };
      this.chunks.set(chunkIdString, chunkEntry);
      this.queues.load.insert(chunkIdString, priority);
    } else {
      const subscriberPriorityIndex = chunkEntry.subscriberPriorities.findIndex(([id]) => id === subscriberId);
      if (subscriberPriorityIndex === -1) {
        chunkEntry.subscriberPriorities.push([subscriberId, priority]);
      } else {
        chunkEntry.subscriberPriorities[subscriberPriorityIndex][1] = priority;
      }

      this.updateChunkPriority(chunkIdString, chunkEntry);
    }
  }

  /** Declares that subscriber `subscriber` no longer requires chunk `chunkId`. */
  removeChunkRequest(subscriber: IDataSubscriber, chunkId: ChunkId) {
    const subscriberId = this.getIdForSubscriber(subscriber);
    const chunkKey = chunkIdToString(chunkId);
    const chunkEntry = this.chunks.get(chunkKey);
    if (chunkEntry === undefined) {
      return;
    }

    const index = chunkEntry.subscriberPriorities.findIndex(([id]) => id === subscriberId);
    if (index < 0) {
      return;
    }

    swapRemove(chunkEntry.subscriberPriorities, index);
    this.updateChunkPriority(chunkKey, chunkEntry);
  }
}
