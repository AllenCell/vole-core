import type { TypedArray } from "three";

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
  limitForPriority,
  ChunkPriorityLevel,
} from "./types.js";
import { PriorityQueue } from "./PriorityQueue.js";

export interface IChunkSource {
  getChunk(id: LocalChunkId, abortSignal?: AbortSignal): Promise<TypedArray>;
}

type ChunkQueue = PriorityQueue<ChunkPriority, string>;

class ChunkQueues {
  load: ChunkQueue = new PriorityQueue(chunkPriorityGreater);
  evict: ChunkQueue = new PriorityQueue(chunkPriorityLess);
  deviceLoad: ChunkQueue = new PriorityQueue(chunkPriorityGreater);
  deviceEvict: ChunkQueue = new PriorityQueue(chunkPriorityLess);
  recentCounter = 0;

  /** Resolves a chunk's overall priority based on all requests for it, then updates its queue position. */
  update(key: string, entry: ChunkEntry) {
    const nextPriority = entry.subscriberPriorities.reduce((prevPriority, [_, priority]) => {
      return chunkPriorityGreater(priority, prevPriority) ? priority : prevPriority;
    }, MIN_CHUNK_PRIORITY);

    if (nextPriority.level === ChunkPriorityLevel.RECENT) {
      nextPriority.score = this.recentCounter;
      this.recentCounter += 1;
    } else if (nextPriority.level === entry.priority.level && nextPriority.score === entry.priority.score) {
      return;
    }

    entry.priority = nextPriority;

    switch (entry.data.state) {
      case ChunkState.QUEUED:
        this.load.insert(key, nextPriority);
        break;
      case ChunkState.MEMORY:
        this.deviceLoad.insert(key, nextPriority);
        this.evict.insert(key, nextPriority);
        break;
      case ChunkState.DEVICE:
        this.deviceEvict.insert(key, nextPriority);
        break;
      case ChunkState.LOADING:
      case ChunkState.WORKER:
    }
  }
}

export class DataManager {
  private chunks = new Map<string, ChunkEntry>();
  private queues = new ChunkQueues();
  private sources: IChunkSource[] = [];
  private requests = new Map<string, AbortController>();
  private memorySize = 0;
  private deviceSize = 0;

  public limits: DataManagerLimits;

  constructor(limits?: Partial<DataManagerLimits>) {
    this.limits = validateDataManagerLimits({
      ...DEFAULT_DATA_MANAGER_LIMITS,
      ...(limits ?? {}),
    });
  }

  private updateDeviceData() {}

  private onChunkLoad(id: ChunkId, data: TypedArray) {
    // If this just freed up our request quota, make sure to fill it back up
    this.requests.delete(chunkIdToString(id));
    this.submitRequests();
  }

  submitRequests() {
    let nextRequest = this.queues.load.peek();

    while (nextRequest !== undefined && this.requests.size < limitForPriority(this.limits, nextRequest[0])) {
      this.queues.load.pop();

      const key = nextRequest[1];
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

  /**
   *
   */
  requestChunk(subscriberId: number, chunkId: ChunkId, priority: ChunkPriority) {
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

      this.queues.update(chunkIdString, chunkEntry);
    }
  }
}
