import type { NumberType, TypedArray } from "../types.ts";

/** Settings for the maximum resources a `DataManager` may use (memory, request concurrency, etc.) */
export type DataManagerLimits = {
  /** The maximum amount of data that can be kept in memory, in bytes. */
  size: number;
  /**
   * The maximum amount of data that can be kept on the GPU, in bytes.
   *
   * Cannot be set higher than `size`.
   */
  deviceSize: number;
  /**
   * The maximum amount of data that can be kept on the GPU if at least some GPU data has the `PREFETCH` priority.
   *
   * Setting this lower than `deviceSize` keeps the data manager from prematurely filling up GPU memory with prefetched
   * data that may never be used. Cannot be set higher than `deviceSize`.
   */
  devicePrefetchSize: number;
  /** The maximum number of concurrent requests. */
  concurrentRequests: number;
  /**
   * The maximum number of concurrent requests if at least one request has the `PREFETCH` priority.
   *
   * Setting this lower than `concurrentRequests` ensures that some concurrency always remains available for requests
   * with the `VISIBLE` priority. Cannot be set higher than `concurrentRequests`.
   */
  concurrentPrefetches: number;
};

const ONE_GIGABYTE = 1024 * 1024 * 1024;

export const DEFAULT_DATA_MANAGER_LIMITS: DataManagerLimits = {
  size: ONE_GIGABYTE,
  deviceSize: ONE_GIGABYTE,
  devicePrefetchSize: ONE_GIGABYTE / 2,
  concurrentRequests: 10,
  concurrentPrefetches: 4,
};

/** Enforces validity requirements on `DataManagerLimits`, e.g. `deviceSize` must not be greater than `size`. */
export const validateDataManagerLimits = (limits: DataManagerLimits): DataManagerLimits => ({
  ...limits,
  deviceSize: Math.min(limits.size, limits.deviceSize),
  devicePrefetchSize: Math.min(limits.size, limits.deviceSize, limits.devicePrefetchSize),
  concurrentPrefetches: Math.min(limits.concurrentRequests, limits.concurrentPrefetches),
});

/** Reasons that a chunk is tracked by `DataManager`, in increasing order of priority. */
export const enum ChunkPriorityLevel {
  /**
   * The chunk was recently loaded but is not currently needed.
   *
   * A chunk is automatically assigned a priority at this level when one or more subscribers request it (at the
   * `VISIBLE` or `PREFETCH` level), its data is loaded, and then all requests are removed. Subscribers shouldn't use
   * this level explicitly when making requests: if the chunk isn't already cached, the request will be ignored!
   */
  RECENT = 0,
  /**
   * The chunk isn't currently visible, but is expected to become necessary in the future.
   *
   * Besides being loaded after `VISIBLE` chunks, chunks prioritized at this level may be subject to lower request
   * quotas and/or memory limits, depending on the `DataManager`'s configuration.
   */
  PREFETCH = 1,
  /** The chunk is currently needed for rendering. */
  VISIBLE = 2,
}

/**
 * The priority at which a chunk is required.
 *
 * Chunks are prioritized by their `ChunkPriorityLevel`, then within their level by a numeric score.
 */
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

export const getMinChunkPriority = (): ChunkPriority => ({ level: ChunkPriorityLevel.RECENT, score: 0 });
/** Result is less than `0` if `a > b`, greater than `0` if `a < b`, or `0` if `a === b` */
export const comparePriority = (a: ChunkPriority, b: ChunkPriority): number =>
  a.level !== b.level ? b.level - a.level : b.score - a.score;
/** Result is greater than `0` if `a > b`, less than `0` if `a < b`, or `0` if `a === b` */
export const reverseComparePriority = (a: ChunkPriority, b: ChunkPriority): number =>
  a.level !== b.level ? a.level - b.level : a.score - b.score;

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

export type ChunkData<Tex> =
  | { state: ChunkState.QUEUED | ChunkState.WORKER | ChunkState.LOADING }
  | { state: ChunkState.MEMORY; memory: TypedArray; dtype: NumberType }
  | { state: ChunkState.DEVICE; memory: TypedArray; dtype: NumberType; texture: Tex };

export type SubscriberPriority = {
  subscriberId: number;
  priority: ChunkPriority;
  device: boolean;
};

/** `DataManager`-internal type containing full state of a single chunk. */
export type ChunkEntry<Tex> = {
  /** The current lifecycle state of a chunk, and the data associated with it. */
  data: ChunkData<Tex>;
  /** A record of every request for this chunk. */
  subscriberPriorities: SubscriberPriority[];
  /** Priority at which the chunk is required in memory. Derived from `subscriberPriorities` on request add/remove. */
  memoryPriority: ChunkPriority;
  /**
   * Priority at which the chunk is required in GPU memory. Derived from `subscriberPriorities` on request add/remove.
   *
   * Must never be greater than `memoryPriority`.
   */
  devicePriority: ChunkPriority;
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

export type Chunk<T extends NumberType> = {
  data: TypedArray<T>;
  dtype: T;
};
