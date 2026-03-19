import type { ChunkId, ChunkPriority, ChunkEntry } from "./types.js";
import { chunkIdToString, ChunkState, compareChunkPriority } from "./types.js";
import { PriorityQueue } from "./PriorityQueue.js";

export class DataManager {
  chunks: Map<string, ChunkEntry>;
  loadQueue: PriorityQueue<ChunkPriority, string>;

  constructor() {
    this.chunks = new Map();
    this.loadQueue = new PriorityQueue(compareChunkPriority);
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
      if (compareChunkPriority(priority, chunkEntry.priority)) {
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
