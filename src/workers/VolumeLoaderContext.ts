import { deserializeError } from "serialize-error";
import { throttledQueue } from "throttled-queue";

import { ImageInfo } from "../ImageInfo.js";
import { VolumeDims } from "../VolumeDims.js";
import { CreateLoaderOptions, PrefetchDirection, VolumeFileFormat, pathToFileType } from "../loaders/index.js";
import {
  ThreadableVolumeLoader,
  LoadSpec,
  RawChannelDataCallback,
  LoadedVolumeInfo,
} from "../loaders/IVolumeLoader.js";
import { RawArrayLoader } from "../loaders/RawArrayLoader.js";
import { TiffLoader } from "../loaders/TiffLoader.js";
import type {
  ChannelLoadEvent,
  MetadataUpdateEvent,
  WorkerMsgTypeGlobal,
  WorkerMsgTypeWithLoader,
  WorkerRequestPayload,
  WorkerResponse,
  WorkerResponsePayload,
} from "./types.js";
import type { ZarrLoaderFetchOptions } from "../loaders/OmeZarrLoader.js";
import { WorkerMsgType, WorkerResponseResult, WorkerEventType } from "./types.js";
import { rebuildLoadSpec } from "./util.js";

type StoredPromise<T extends WorkerMsgType> = {
  type: T;
  resolve: (value: WorkerResponsePayload<T>) => void;
  reject: (reason?: unknown) => void;
};

const throttle = throttledQueue({ maxPerInterval: 1, interval: 16 });
/**
 * A handle that holds the worker and manages requests and messages to/from it.
 *
 * `VolumeLoaderContext` and every `LoaderWorker` it creates all hold references to one `SharedLoadWorkerHandle`.
 * They use it to interact with the worker via `sendMessage`, which speaks the protocol defined in ./types.ts and
 * converts messages received from the worker into resolved `Promise`s and called callbacks.
 *
 * This class exists to represent that access to the worker is shared between `VolumeLoaderContext` and any
 * `LoaderWorker`s. This is as opposed to implementing `sendMessage` directly on `VolumeLoaderContext`, where making
 * the method public to `LoaderWorker`s would require also allowing access to users of the class.
 */
class SharedLoadWorkerHandle {
  private worker: Worker;
  private pendingRequests: (StoredPromise<WorkerMsgType> | undefined)[] = [];
  private workerOpen = true;

  public onEvent: ((e: ChannelLoadEvent | MetadataUpdateEvent) => void) | undefined = undefined;

  constructor() {
    this.worker = new Worker(new URL("./VolumeLoadWorker", import.meta.url), { type: "module" });
    this.worker.onmessage = this.receiveMessage.bind(this);
  }

  /** Given a handle for settling a promise when a response is received from the worker, store it and return its ID */
  private registerMessagePromise(prom: StoredPromise<WorkerMsgType>): number {
    for (const [i, pendingPromise] of this.pendingRequests.entries()) {
      if (pendingPromise === undefined) {
        this.pendingRequests[i] = prom;
        return i;
      }
    }

    return this.pendingRequests.push(prom) - 1;
  }

  get isOpen(): boolean {
    return this.workerOpen;
  }

  /** Close the worker. */
  close(): void {
    this.worker.terminate();
    this.workerOpen = false;
  }

  /**
   * Send a message of type `T` to the worker.
   * Returns a `Promise` that resolves with the worker's response, or rejects with an error message.
   */
  // overload 1: message is a global action and does not require a loader ID
  sendMessage<T extends WorkerMsgTypeGlobal>(
    type: T,
    payload: WorkerRequestPayload<T>
  ): Promise<WorkerResponsePayload<T>>;
  // overload 2: message is a loader-specific action and requires a loader ID
  sendMessage<T extends WorkerMsgTypeWithLoader>(
    type: T,
    payload: WorkerRequestPayload<T>,
    loaderId: number
  ): Promise<WorkerResponsePayload<T>>;
  sendMessage<T extends WorkerMsgType>(
    type: T,
    payload: WorkerRequestPayload<T>,
    loaderId: T extends WorkerMsgTypeWithLoader ? number : void
  ): Promise<WorkerResponsePayload<T>> {
    let msgId = -1;
    const promise = new Promise<WorkerResponsePayload<T>>((resolve, reject) => {
      msgId = this.registerMessagePromise({ type, resolve, reject } as StoredPromise<WorkerMsgType>);
    });

    const msg = { msgId, type, payload, loaderId };
    this.worker.postMessage(msg);

    return promise;
  }

  /** Receive a message from the worker. If it's an event, call a callback; otherwise, resolve/reject a promise. */
  private receiveMessage<T extends WorkerMsgType>({ data }: MessageEvent<WorkerResponse<T>>): void {
    if (data.responseResult === WorkerResponseResult.EVENT) {
      this.onEvent?.(data);
    } else {
      const prom = this.pendingRequests[data.msgId];

      if (prom === undefined) {
        throw new Error(`Received response for unknown message ID ${data.msgId}`);
      }
      if (prom.type !== data.type) {
        throw new Error(`Received response of type ${data.type} for message of type ${prom.type}`);
      }

      if (data.responseResult === WorkerResponseResult.ERROR) {
        prom.reject(deserializeError(data.payload));
      } else {
        prom.resolve(data.payload);
      }
      this.pendingRequests[data.msgId] = undefined;
    }
  }
}

/**
 * A context in which volume loaders can be run, which allows loading to run on a WebWorker (where it won't block
 * rendering or UI updates) and loaders to share a single `VolumeCache` and `RequestQueue`.
 *
 * # To use:
 * 1. Create a `VolumeLoaderContext` with the desired cache and queue configuration.
 * 2. Before creating a loader, await `onOpen` to ensure the worker is ready.
 * 3. Create a loader with `createLoader`. This accepts nearly the same arguments as `createVolumeLoader`, but without
 *    options to directly link to a cache or queue (the loader will always be linked to the context's shared instances
 *    of these if possible).
 *
 * The returned `WorkerLoader` can be used like any other `IVolumeLoader` and acts as a handle to the actual loader
 * running on the worker.
 */
class VolumeLoaderContext {
  private workerHandle: SharedLoadWorkerHandle;
  private loaders: Map<number, WorkerLoader>;
  private openPromise: Promise<void>;
  private throttleChannelData = false;

  constructor(
    maxCacheSize?: number,
    maxActiveRequests?: number,
    maxLowPriorityRequests?: number,
    maxLowResCacheSize?: number
  ) {
    this.workerHandle = new SharedLoadWorkerHandle();
    this.workerHandle.onEvent = this.handleEvent.bind(this);
    this.loaders = new Map();
    this.openPromise = this.workerHandle.sendMessage(WorkerMsgType.INIT, {
      maxCacheSize,
      maxLowResCacheSize,
      maxActiveRequests,
      maxLowPriorityRequests,
    });
  }

  /** Returns a `Promise` that resolves when the worker is ready. `await` it before trying to create a loader. */
  onOpen(): Promise<void> {
    if (!this.workerHandle.isOpen) {
      return Promise.reject("Worker is closed");
    }
    return this.openPromise;
  }

  /** Close this context, its worker, and any active loaders. */
  close(): void {
    this.workerHandle.close();
  }

  private handleEvent(e: ChannelLoadEvent | MetadataUpdateEvent): void {
    const loader = this.loaders.get(e.loaderId);
    if (loader) {
      if (e.eventType === WorkerEventType.CHANNEL_LOAD) {
        if (this.throttleChannelData) {
          throttle(() => loader.onChannelData(e));
        } else {
          loader.onChannelData(e);
        }
      } else if (e.eventType === WorkerEventType.METADATA_UPDATE) {
        loader.onUpdateMetadata(e);
      }
    }
  }

  /**
   * Create a new loader within this context. This loader will share the context's `VolumeCache` and `RequestQueue`.
   *
   * This works just like `createVolumeLoader`. A file format may be provided, or it may be inferred from the URL.
   */
  async createLoader(
    path: string | string[],
    options?: Omit<CreateLoaderOptions, "cache" | "lowResCache" | "queue">
  ): Promise<WorkerLoader | TiffLoader | RawArrayLoader> {
    // Special case: TIFF loader doesn't work on a worker, has its own workers anyways, and doesn't use cache or queue.
    const pathString = Array.isArray(path) ? path[0] : path;
    const fileType = options?.fileType || pathToFileType(pathString);
    if (fileType === VolumeFileFormat.TIFF) {
      // tiff loader accepts array of paths for separate channel sources
      const pathArray = Array.isArray(path) ? path : [path];
      return new TiffLoader(pathArray);
    } else if (fileType === VolumeFileFormat.DATA) {
      if (!options?.rawArrayOptions) {
        throw new Error("Failed to create loader: Must provide RawArrayOptions for RawArrayLoader");
      }
      return new RawArrayLoader(options.rawArrayOptions.data, options.rawArrayOptions.metadata);
    }

    const loaderId = await this.workerHandle.sendMessage(WorkerMsgType.CREATE_LOADER, { path, options });
    if (loaderId === undefined) {
      throw new Error("Failed to create loader");
    }

    const loader = new WorkerLoader(loaderId, this.workerHandle, this);
    this.loaders.set(loaderId, loader);
    return loader;
  }

  setThrottleChannelData(throttle: boolean): void {
    this.throttleChannelData = throttle;
  }
}

/**
 * A handle to an instance of `IVolumeLoader` (technically, a `ThreadableVolumeLoader`) running on a WebWorker.
 *
 * Created with `VolumeLoaderContext.createLoader`. See its documentation for more.
 */
class WorkerLoader extends ThreadableVolumeLoader {
  private loaderId: number | undefined;
  private workerHandle: SharedLoadWorkerHandle;
  private context: VolumeLoaderContext;
  private currentLoadId = -1;
  private currentLoadCallback: RawChannelDataCallback | undefined = undefined;
  private currentMetadataUpdateCallback: ((imageInfo?: ImageInfo, loadSpec?: LoadSpec) => void) | undefined = undefined;

  constructor(loaderId: number, workerHandle: SharedLoadWorkerHandle, context: VolumeLoaderContext) {
    super();
    this.loaderId = loaderId;
    this.workerHandle = workerHandle;
    this.context = context;
  }

  private getLoaderId(): number {
    if (this.loaderId === undefined || !this.workerHandle.isOpen) {
      throw new Error("Tried to use a closed loader");
    }
    return this.loaderId;
  }

  getContext(): VolumeLoaderContext {
    return this.context;
  }

  /** Close and permanently invalidate this loader. */
  close(): void {
    if (this.loaderId === undefined) {
      return;
    }
    this.workerHandle.sendMessage(WorkerMsgType.CLOSE_LOADER, undefined, this.loaderId);
    this.loaderId = undefined;
  }

  /**
   * Change which directions to prioritize when prefetching. All chunks will be prefetched in these directions before
   * any chunks are prefetched in any other directions. Has no effect if this loader doesn't support prefetching.
   */
  setPrefetchPriority(directions: PrefetchDirection[]): Promise<void> {
    return this.workerHandle.sendMessage(
      WorkerMsgType.SET_PREFETCH_PRIORITY_DIRECTIONS,
      directions,
      this.getLoaderId()
    );
  }

  updateFetchOptions(fetchOptions: Partial<ZarrLoaderFetchOptions>): Promise<void> {
    return this.workerHandle.sendMessage(WorkerMsgType.UPDATE_FETCH_OPTIONS, fetchOptions, this.getLoaderId());
  }

  syncMultichannelLoading(sync: boolean): Promise<void> {
    return this.workerHandle.sendMessage(WorkerMsgType.SYNCHRONIZE_MULTICHANNEL_LOADING, sync, this.getLoaderId());
  }

  loadDims(loadSpec: LoadSpec): Promise<VolumeDims[]> {
    return this.workerHandle.sendMessage(WorkerMsgType.LOAD_DIMS, loadSpec, this.getLoaderId());
  }

  async createImageInfo(loadSpec: LoadSpec): Promise<LoadedVolumeInfo> {
    const { imageInfo, loadSpec: adjustedLoadSpec } = await this.workerHandle.sendMessage(
      WorkerMsgType.CREATE_VOLUME,
      loadSpec,
      this.getLoaderId()
    );
    return { imageInfo, loadSpec: rebuildLoadSpec(adjustedLoadSpec) };
  }

  loadRawChannelData(
    imageInfo: ImageInfo,
    loadSpec: LoadSpec,
    onUpdateMetadata: (imageInfo?: ImageInfo, loadSpec?: LoadSpec) => void,
    onData: RawChannelDataCallback
  ): Promise<void> {
    this.currentLoadCallback = onData;
    this.currentMetadataUpdateCallback = onUpdateMetadata;
    this.currentLoadId += 1;

    const message: WorkerRequestPayload<WorkerMsgType.LOAD_VOLUME_DATA> = {
      imageInfo,
      loadSpec,
      loadId: this.currentLoadId,
    };
    return this.workerHandle.sendMessage(WorkerMsgType.LOAD_VOLUME_DATA, message, this.getLoaderId());
  }

  onChannelData(e: ChannelLoadEvent): void {
    if (e.loaderId !== this.loaderId || e.loadId !== this.currentLoadId) {
      return;
    }

    this.currentLoadCallback?.(e.channelIndex, e.dtype, e.data, e.ranges, e.atlasDims);
  }

  onUpdateMetadata(e: MetadataUpdateEvent): void {
    if (e.loaderId !== this.loaderId || e.loadId !== this.currentLoadId) {
      return;
    }

    const imageInfo = e.imageInfo;
    const loadSpec = e.loadSpec && rebuildLoadSpec(e.loadSpec);
    this.currentMetadataUpdateCallback?.(imageInfo, loadSpec);
  }
}

export default VolumeLoaderContext;
export type { WorkerLoader };
