import { DataTexture } from "three";

export type DataManagerLimits = {
  size: number;
  deviceSize: number;
  concurrentRequests: number;
  concurrentPrefetches: number;
};

const ONE_GIGABYTE = 1024 * 1024 * 1024;

export const DEFAULT_DATA_MANAGER_LIMITS: DataManagerLimits = {
  size: ONE_GIGABYTE,
  deviceSize: ONE_GIGABYTE,
  concurrentRequests: 10,
  concurrentPrefetches: 4,
};

export const validateDataManagerLimits = (limits: DataManagerLimits): DataManagerLimits => ({
  ...limits,
  deviceSize: Math.min(limits.size, limits.deviceSize),
  concurrentPrefetches: Math.min(limits.concurrentRequests, limits.concurrentPrefetches),
});

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

export const MIN_CHUNK_PRIORITY: ChunkPriority = { class: ChunkPriorityClass.RECENT, score: 0 };
/** Returns true iff `a > b` */
export const chunkPriorityGreater = (a: ChunkPriority, b: ChunkPriority) =>
  a.class !== b.class ? a.class > b.class : a.score > b.score;
export const chunkPriorityLess = (a: ChunkPriority, b: ChunkPriority) =>
  a.class !== b.class ? a.class < b.class : a.score < b.score;

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
