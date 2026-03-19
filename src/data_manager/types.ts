import { DataTexture } from "three";

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
export const compareChunkPriority = (a: ChunkPriority, b: ChunkPriority) =>
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

export type ChunkEntry = ChunkData & {
  subscriberPriorities: [number, ChunkPriority][];
  priority: ChunkPriority;
};

// export interface DataSubscriber {}

export type ChunkId = {
  sourceId: number;
  multiscaleIndex: number;
  tczyx: [number, number, number, number, number];
};

export const chunkIdToString = (id: ChunkId): string => `${id.sourceId}:${id.multiscaleIndex}:${id.tczyx.join(",")}`;

export const stringToChunkId = (id: string): ChunkId => {
  const [sourceId, multiscaleIndex, tczyx] = id.split(":");
  const [t, c, z, y, x] = tczyx.split(",");
  return {
    sourceId: parseInt(sourceId),
    multiscaleIndex: parseInt(multiscaleIndex),
    tczyx: [parseInt(t), parseInt(c), parseInt(z), parseInt(y), parseInt(x)],
  };
};
