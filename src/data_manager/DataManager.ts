import type { TypedArray } from "three";

import type { ChunkId, ChunkPriority, ChunkEntry, DataManagerLimits } from "./types.js";
import {
  chunkIdToString,
  ChunkState,
  chunkPriorityGreater,
  chunkPriorityLess,
  MIN_CHUNK_PRIORITY,
  validateDataManagerLimits,
  DEFAULT_DATA_MANAGER_LIMITS,
  ChunkPriorityClass,
  stringToChunkId,
} from "./types.js";
import { PriorityQueue } from "./PriorityQueue.js";
import { CreateLoaderOptions } from "../loaders/index.js";

type SourceId = number;

interface SourceContext {
  createSource: (path: string | string[], options?: Omit<CreateLoaderOptions, "cache" | "queue">) => Promise<SourceId>;
  requestChunk: (id: ChunkId) => void;
  abortChunk: (id: ChunkId) => void;
  onChunkLoad: (id: ChunkId, data: TypedArray) => void;
}

type ChunkQueue = PriorityQueue<ChunkPriority, string>;

class ChunkQueues {
  load: ChunkQueue = new PriorityQueue(chunkPriorityGreater);
  evict: ChunkQueue = new PriorityQueue(chunkPriorityLess);
  deviceLoad: ChunkQueue = new PriorityQueue(chunkPriorityGreater);
  deviceEvict: ChunkQueue = new PriorityQueue(chunkPriorityLess);

  update(key: string, entry: ChunkEntry) {
    const nextPriority = entry.subscriberPriorities.reduce((prevPriority, [_, priority]) => {
      return chunkPriorityGreater(priority, prevPriority) ? priority : prevPriority;
    }, MIN_CHUNK_PRIORITY);

    if (nextPriority.class === entry.priority.class && nextPriority.score === entry.priority.score) {
      return;
    }

    entry.priority = nextPriority;

    switch (entry.state) {
      case ChunkState.QUEUED:
      case ChunkState.LOADING:
      case ChunkState.WORKER:
      case ChunkState.MEMORY:
      case ChunkState.DEVICE:
    }
  }
}

export class DataManager {
  private chunks: Map<string, ChunkEntry>;
  private loadQueue: PriorityQueue<ChunkPriority, string>;
  private requestCount: number;
  private context: SourceContext;

  public limits: DataManagerLimits;

  constructor(context: SourceContext, limits?: DataManagerLimits) {
    this.limits = {
      ...DEFAULT_DATA_MANAGER_LIMITS,
      ...(limits ? validateDataManagerLimits(limits) : {}),
    };
    this.context = context;
    this.chunks = new Map();
    this.loadQueue = new PriorityQueue(chunkPriorityGreater);
    this.requestCount = 0;
  }

  private trySubmitOneRequest(): boolean {
    const nextRequest = this.loadQueue.peek();
    if (nextRequest === undefined) {
      return false;
    }

    const [priority, key] = nextRequest;
    const { concurrentRequests, concurrentPrefetches } = this.limits;
    const requestLimit =
      priority.class === ChunkPriorityClass.VISIBLE
        ? concurrentRequests
        : priority.class === ChunkPriorityClass.PREFETCH
        ? concurrentPrefetches
        : 0;

    if (this.requestCount >= requestLimit) {
      return false;
    }

    this.loadQueue.pop();
    this.context.requestChunk(stringToChunkId(key));
    this.requestCount++;

    return true;
  }

  requestChunk(subscriberId: number, chunkId: ChunkId, priority: ChunkPriority) {
    const chunkIdString = chunkIdToString(chunkId);
    let chunkEntry = this.chunks.get(chunkIdString);

    if (chunkEntry === undefined) {
      chunkEntry = {
        state: ChunkState.QUEUED,
        subscriberPriorities: [[subscriberId, priority]],
        priority,
      };
      this.chunks.set(chunkIdString, chunkEntry);
      this.loadQueue.insert(chunkIdString, priority);
    } else {
      if (chunkPriorityGreater(priority, chunkEntry.priority)) {
        chunkEntry.priority = priority;
      }

      const subscriberPriorityIndex = chunkEntry.subscriberPriorities.findIndex(([id]) => id === subscriberId);
      if (subscriberPriorityIndex === -1) {
        chunkEntry.subscriberPriorities.push([subscriberId, priority]);
      } else {
        chunkEntry.subscriberPriorities[subscriberPriorityIndex][1] = priority;
      }
    }
  }
}
