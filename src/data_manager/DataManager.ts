import type { Data3DTexture, TypedArray } from "three";

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

export interface ChunkSource {
  getChunk(id: LocalChunkId, signal?: AbortSignal): Promise<TypedArray>;
}

export interface DataSubscriber {
  dataSubscriberId?: number;
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

type ChunkQueue = PriorityQueue<ChunkPriority, string>;

class ChunkQueues {
  load: ChunkQueue = new PriorityQueue(chunkPriorityGreater);
  evict: ChunkQueue = new PriorityQueue(chunkPriorityLess);
  deviceLoad: ChunkQueue = new PriorityQueue(chunkPriorityGreater);
  deviceEvict: ChunkQueue = new PriorityQueue(chunkPriorityLess);
}

export class DataManager {
  private chunks = new Map<string, ChunkEntry>();
  private queues = new ChunkQueues();
  private sources: ChunkSource[] = [];
  private requests = new Map<string, AbortController>();
  private memorySize = 0;
  private deviceSize = 0;
  private recentCounter = 0;

  public limits: DataManagerLimits;

  constructor(limits?: Partial<DataManagerLimits>) {
    this.limits = validateDataManagerLimits({
      ...DEFAULT_DATA_MANAGER_LIMITS,
      ...(limits ?? {}),
    });
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
          // TODO cancel request
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

  submitRequests() {
    let nextRequest = this.queues.load.peek();

    while (nextRequest !== undefined && this.requests.size < requestLimitForPriority(this.limits, nextRequest[0])) {
      this.queues.load.pop();

      const [priority, key] = nextRequest;
      if (priority.level === ChunkPriorityLevel.RECENT) {
        // Ignore requests at the `RECENT` level. That's supposed to be for chunks that are already loaded!
        continue;
      }

      const id = stringToChunkId(key);
      const source = this.sources[id.sourceId];
      const abortController = new AbortController();
      this.requests.set(key, abortController);

      source
        .getChunk(id, abortController.signal)
        .then((data) => this.onChunkLoad(id, data))
        .catch(() => {
          this.chunks.delete(key);
          this.requests.delete(key);
        });

      nextRequest = this.queues.load.peek();
    }
  }

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
        console.warn(`chunk ${loadKey} queued for device upload without data`);
        this.queues.deviceLoad.pop();
        this.queues.evict.remove(loadKey);
        continue;
      }
      if (loadEntry.data.state !== ChunkState.MEMORY) {
        console.warn(
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
        !(this.deviceSize + chunkSize < deviceSizeLimitForPriority(this.limits, loadPriority)) &&
        // ...or if its priority is greater than the lowest-priority chunk that's already on the GPU.
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

    // STEP 2: evict chunks that have been pushed off the GPU, keeping hold of their textures in case they're reusable
    const freedTextures: Data3DTexture[] = [];
    let nextEvict = this.queues.deviceEvict.peek();
    while (nextEvict !== undefined && this.deviceSize >= deviceSizeLimitForPriority(this.limits, nextEvict[0])) {
      const [evictPriority, evictKey] = nextEvict;
      this.queues.deviceEvict.pop();
      this.queues.deviceLoad.insert(evictKey, evictPriority);
      this.queues.evict.insert(evictKey, evictPriority);

      const evictEntry = this.chunks.get(evictKey);
      if (evictEntry !== undefined) {
        if (evictEntry.data.state === ChunkState.DEVICE) {
          // this chunk was previously on the GPU; demote to `MEMORY` and save its texture
          const memory = evictEntry.data.texture.image.data;
          this.deviceSize -= memory.byteLength;
          freedTextures.push(evictEntry.data.texture);
          evictEntry.data = { state: ChunkState.MEMORY, memory };
        } else if (evictEntry.data.state === ChunkState.MEMORY) {
          // this chunk was promoted in the previous step; put it back
          this.deviceSize -= evictEntry.data.memory.byteLength;
          const index = loads.findIndex(([_, entry]) => entry === evictEntry);
          swapRemove(loads, index);
        } else {
          console.warn(
            `chunk ${evictKey} queued for device evict in invalid state (expected "device" or "memory", found ${evictEntry.data.state})`
          );
        }
      } else {
        console.warn(`chunk ${evictKey} queued for device evict without data`);
      }

      nextEvict = this.queues.deviceEvict.peek();
    }

    // STEP 3: now we can actually set up textures
    for (const [loadKey, loadEntry] of loads) {
      // TODO
    }

    freedTextures.forEach((tex) => tex.dispose());
  }

  private onChunkLoad(id: ChunkId, data: TypedArray) {
    // If this just freed up our request quota, make sure to fill it back up
    this.requests.delete(chunkIdToString(id));
    this.submitRequests();
  }

  /**
   *
   */
  queueChunkRequest(subscriberId: number, chunkId: ChunkId, priority: ChunkPriority) {
    const chunkIdString = chunkIdToString(chunkId);
    let chunkEntry = this.chunks.get(chunkIdString);

    if (chunkEntry === undefined) {
      chunkEntry = {
        data: { state: ChunkState.QUEUED },
        subscriberPriorities: [[subscriberId, priority]],
        priority: MIN_CHUNK_PRIORITY,
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

  removeChunkRequest(subscriberId: number, chunkId: ChunkId, priority: ChunkPriority) {}
}
