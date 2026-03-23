import { Data3DTexture, TypedArray } from "three";

export type DataManagerLimits = {
  size: number;
  deviceSize: number;
  devicePrefetchSize: number;
  concurrentRequests: number;
  concurrentPrefetches: number;
};

const ONE_GIGABYTE = 1024 * 1024 * 1024;

export const DEFAULT_DATA_MANAGER_LIMITS: DataManagerLimits = {
  /** The maximum amount of data that can be kept in memory, in bytes. */
  size: ONE_GIGABYTE,
  /**
   * The maximum amount of data that can be kept on the GPU, in bytes.
   *
   * Cannot be set higher than `size`.
   */
  deviceSize: ONE_GIGABYTE,
  /**
   * The maximum amount of data that can be kept on the GPU if at least some GPU data has the `PREFETCH` priority.
   *
   * Setting this lower than `deviceSize` keeps the data manager from prematurely filling up GPU memory with prefetched
   * data that may never be used. Cannot be set higher than `deviceSize`.
   */
  devicePrefetchSize: ONE_GIGABYTE / 2,
  /** The maximum number of concurrent requests. */
  concurrentRequests: 10,
  /**
   * The maximum number of concurrent requests if at least one request has the `PREFETCH` priority.
   *
   * Setting this lower than `concurrentRequests` ensures that some concurrency always remains available for requests
   * with the `VISIBLE` priority. Cannot be set higher than `concurrentRequests`.
   */
  concurrentPrefetches: 4,
};

export const validateDataManagerLimits = (limits: DataManagerLimits): DataManagerLimits => ({
  ...limits,
  deviceSize: Math.min(limits.size, limits.deviceSize),
  devicePrefetchSize: Math.min(limits.size, limits.deviceSize, limits.devicePrefetchSize),
  concurrentPrefetches: Math.min(limits.concurrentRequests, limits.concurrentPrefetches),
});

export const enum ChunkPriorityLevel {
  /**
   * Chunks that were recently loaded but which aren't currently needed.
   *
   * A chunk is automatically assigned a priority at this level when one or more subscribers request them (at the
   * `VISIBLE` or `PREFETCH` level), their data is loaded, and then all requests are removed. Subscribers shouldn't use
   * this level explicitly when making requests -- if the chunk isn't already cached, the request will be ignored!
   */
  RECENT = 0,
  /**
   * Chunks that aren't currently visible, but that are expected to become necessary in the future.
   *
   * Besides being loaded after `VISIBLE` chunks, chunks prioritized at this level may be subject to lower request
   * quotas and/or memory limits, depending on the `DataManager`'s configuration.
   */
  PREFETCH = 1,
  /** Chunks that are currently needed for rendering. */
  VISIBLE = 2,
}

export type ChunkPriority = {
  level: ChunkPriorityLevel;
  score: number;
};

export const requestLimitForPriority = (limits: DataManagerLimits, { level }: ChunkPriority): number =>
  level === ChunkPriorityLevel.VISIBLE
    ? limits.concurrentRequests
    : level === ChunkPriorityLevel.PREFETCH
    ? limits.concurrentPrefetches
    : 1;

export const deviceSizeLimitForPriority = (limits: DataManagerLimits, { level }: ChunkPriority): number =>
  level === ChunkPriorityLevel.VISIBLE
    ? limits.deviceSize
    : level === ChunkPriorityLevel.PREFETCH
    ? limits.devicePrefetchSize
    : 0;

export const MIN_CHUNK_PRIORITY: ChunkPriority = { level: ChunkPriorityLevel.RECENT, score: 0 };
/** Returns true iff `a > b` */
export const chunkPriorityGreater = (a: ChunkPriority, b: ChunkPriority) =>
  a.level !== b.level ? a.level > b.level : a.score > b.score;
/** Returns true iff `a < b` */
export const chunkPriorityLess = (a: ChunkPriority, b: ChunkPriority) =>
  a.level !== b.level ? a.level < b.level : a.score < b.score;

export const enum ChunkState {
  /** Chunk is queued to be loaded. */
  QUEUED = "queued",
  /** Chunk is currently loading. */
  LOADING = "loading",
  /** Chunk is cached in memory. */
  MEMORY = "memory",
  /** Chunk is cached in memory *and* uploaded to the GPU. */
  DEVICE = "device",
  /** Chunk has been temporarily handed off to a worker. Unused, for now. */
  WORKER = "worker",
}

export type ChunkData =
  | { state: ChunkState.QUEUED | ChunkState.WORKER | ChunkState.LOADING }
  | { state: ChunkState.MEMORY; memory: TypedArray }
  | { state: ChunkState.DEVICE; texture: Data3DTexture };

export type ChunkEntry = {
  data: ChunkData;
  subscriberPriorities: [number, ChunkPriority][];
  priority: ChunkPriority;
};

export type LocalChunkId = {
  multiscale: number;
  tczyx: [number, number, number, number, number];
};

export type ChunkId = LocalChunkId & { source: number };

export const chunkIdToString = (id: ChunkId): string => `${id.source}:${id.multiscale}:${id.tczyx.join(",")}`;

export const stringToChunkId = (id: string): ChunkId => {
  const [sourceId, multiscaleIndex, tczyx] = id.split(":");
  const [t, c, z, y, x] = tczyx.split(",");
  return {
    source: parseInt(sourceId),
    multiscale: parseInt(multiscaleIndex),
    tczyx: [parseInt(t), parseInt(c), parseInt(z), parseInt(y), parseInt(x)],
  };
};
