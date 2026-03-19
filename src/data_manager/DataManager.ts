import { DataTexture } from "three";

import { PriorityQueue } from "./PriorityQueue.js";

export const enum ChunkPriorityClass {
  RECENT = 0,
  PREFETCH = 1,
  VISIBLE = 2,
  LENGTH,
}

export type ChunkPriority = {
  class: ChunkPriorityClass;
  score: number;
};

/** Returns true iff `a > b` */
const compareChunkPriority = (a: ChunkPriority, b: ChunkPriority) =>
  a.class !== b.class ? a.class > b.class : a.score > b.score;

export const enum ChunkState {
  QUEUED = "queued",
  LOADING = "loading",
  WORKER = "worker",
  MEMORY = "memory",
  DEVICE = "device",
}

type ChunkData =
  | { state: ChunkState.QUEUED | ChunkState.LOADING | ChunkState.WORKER }
  | { state: ChunkState.MEMORY; memory: ArrayBuffer }
  | { state: ChunkState.DEVICE; texture: DataTexture };

type ChunkEntry = ChunkData & {
  subscriberPriorities: [number, ChunkPriority][];
  priority: ChunkPriority;
};

// export interface DataSubscriber {}

export type ChunkId = {
  sourceId: number;
  multiscaleIndex: number;
  tczyx: [number, number, number, number, number];
};

const chunkIdToString = (id: ChunkId): string => `${id.sourceId}:${id.multiscaleIndex}:${id.tczyx.join(",")}`;

const stringToChunkId = (id: string): ChunkId => {
  const [sourceId, multiscaleIndex, tczyx] = id.split(":");
  const [t, c, z, y, x] = tczyx.split(",");
  return {
    sourceId: parseInt(sourceId),
    multiscaleIndex: parseInt(multiscaleIndex),
    tczyx: [parseInt(t), parseInt(c), parseInt(z), parseInt(y), parseInt(x)],
  };
};

export class DataManager {
  chunks: Map<string, ChunkEntry>;
  loadQueue: PriorityQueue<ChunkPriority, string>;

  constructor() {
    this.chunks = new Map();
    this.loadQueue = new PriorityQueue(compareChunkPriority);
  }

  requestChunk(subscriberId: number, chunkId: ChunkId, priority: ChunkPriority): ArrayBuffer | DataTexture | undefined {
    const chunkIdString = chunkIdToString(chunkId);
    const chunkEntry = this.chunks.get(chunkIdString);

    if (chunkEntry === undefined) {
      this.chunks.set(chunkIdString, {
        state: ChunkState.QUEUED,
        subscriberPriorities: [[subscriberId, priority]],
        priority,
      });
      this.loadQueue.insert(priority, chunkIdString);
      return undefined;
    }

    return undefined;
  }
}
