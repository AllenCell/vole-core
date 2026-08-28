import { Box3, Vector3 } from "three";

import * as zarr from "zarrita";
const { slice } = zarr;

import type { ImageInfo } from "../ImageInfo.js";
import type { VolumeDims } from "../VolumeDims.js";
import VolumeCache from "../VolumeCache.js";
import { getDataRange } from "../utils/num_utils.js";
import SubscribableRequestQueue from "../utils/SubscribableRequestQueue.js";
import {
  ThreadableVolumeLoader,
  LoadSpec,
  type RawChannelDataCallback,
  type LoadedVolumeInfo,
} from "./IVolumeLoader.js";
import {
  composeSubregion,
  computePackedAtlasDims,
  convertSubregionToPixels,
  pickLevelToLoad,
  unitNameToSymbol,
} from "./VolumeLoaderUtils.js";
import ChunkPrefetchIterator from "./zarr_utils/ChunkPrefetchIterator.js";
import {
  getScale,
  getSourceChannelMeta,
  matchSourceScaleLevels,
  orderByDimension,
  orderByTCZYX,
  remapAxesToTCZYX,
} from "./zarr_utils/utils.js";
import type { PrefetchDirection, SubscriberId, TCZYX, ZarrSource, NumericZarrArray } from "./zarr_utils/types.js";
import { VolumeLoadError, VolumeLoadErrorType, wrapVolumeLoadError } from "./VolumeLoadError.js";
import { relaxedFetch, withVoleInstrumentation } from "./zarr_utils/wrappers.js";
import { assertMetadataHasMultiscales, toOMEZarrMetaV4, validateOMEZarrMetadata } from "./zarr_utils/validation.js";
import { remapUri } from "../utils/url_utils.js";
import { type TypedArray } from "../types.js";
import planLowResPrefetch from "./zarr_utils/planLowResPrefetch.js";

const CHUNK_REQUEST_CANCEL_REASON = "chunk request cancelled";
const MINIMUM_LOW_RES_CACHED_EXTENT = 0.7;

// returns the converted data and the original min and max values
function convertChannel(
  channelData: TypedArray<zarr.NumberDataType>,
  dtype: zarr.NumberDataType
): { data: TypedArray<zarr.NumberDataType>; dtype: zarr.NumberDataType; min: number; max: number } {
  // get min and max
  const [min, max] = getDataRange(channelData);

  if (dtype === "float64") {
    // convert to float32
    const f32 = new Float32Array(channelData.length);
    for (let i = 0; i < channelData.length; i++) {
      f32[i] = channelData[i];
    }
    dtype = "float32";
    channelData = f32;
  }

  return { data: channelData, dtype, min, max };
}

export type ZarrLoaderFetchOptions = {
  /** The max. number of requests the loader can issue at a time. Ignored if the constructor also receives a queue. */
  concurrencyLimit?: number;
  /**
   * The max. number of *prefetch* requests the loader can issue at a time. Set lower than `concurrencyLimit` to ensure
   * that prefetching leaves room in the queue for actual loads. Ignored if the constructor also receives a queue.
   */
  prefetchConcurrencyLimit?: number;
  /**
   * The max. number of chunks to prefetch outward in either direction. E.g. if a load requests chunks with z coords 3
   * and 4 and `maxPrefetchDistance` in z is 2, the loader will prefetch similar chunks with z coords 1, 2, 5, and 6
   * (or until it hits `maxPrefetchChunks`). Ordered TZYX.
   */
  maxPrefetchDistance: [number, number, number, number];
  /** The max. number of total chunks that can be prefetched after any load. */
  maxPrefetchChunks: number;
  /** The initial directions to prioritize when prefetching */
  priorityDirections?: PrefetchDirection[];
  /** only use priority directions */
  onlyPriorityDirections?: boolean;
};

type ZarrChunkFetchInfo = {
  sourceIdx: number;
  coords: number[];
};

const DEFAULT_FETCH_OPTIONS = {
  maxPrefetchDistance: [12, 5, 5, 5] as [number, number, number, number],
  maxPrefetchChunks: 30,
};

class OMEZarrLoader extends ThreadableVolumeLoader {
  /** The ID of the subscriber responsible for "actual loads" (non-prefetch requests) */
  private loadSubscriber: SubscriberId | undefined;
  /** The ID of the subscriber responsible for prefetches, so that requests can be cancelled and reissued */
  private prefetchSubscriber: SubscriberId | undefined;
  /** The ID of the subscriber responsible for filling the dedicated low-resolution cache. */
  private lowResWarmSubscriber: SubscriberId | undefined;

  // TODO: this property should definitely be owned by `Volume` if this loader is ever used by multiple volumes.
  //   This may cause errors or incorrect results otherwise!
  private maxExtent?: Box3;

  private syncChannels = false;

  private constructor(
    /**
     * Array of records, each containing the objects and metadata we need to load from one source of multiscale zarr
     * data. See documentation on `ZarrSource` for more.
     */
    private sources: ZarrSource[],
    /** Handle to a `SubscribableRequestQueue` for smart concurrency management and request cancelling/reissuing. */
    private requestQueue: SubscribableRequestQueue,
    /** Optional shared cache for decoded chunks. Keyed by `<baseUrl><arrayPath>/<chunk coords>`. */
    private cache: VolumeCache | undefined,
    /** Optional shared cache for decoded chunks at the coarsest resolution level. */
    private lowResCache: VolumeCache | undefined,
    /** Options to configure (pre)fetching behavior. */
    private fetchOptions: ZarrLoaderFetchOptions = DEFAULT_FETCH_OPTIONS,
    /** Direction(s) to prioritize when prefetching. Stored separate from `fetchOptions` since it may be mutated. */
    private priorityDirections: PrefetchDirection[] = []
  ) {
    super();
  }

  /**
   * Creates a new `OMEZarrLoader`.
   *
   * @param urls The URL(s) of the OME-Zarr data to load. If `urls` is an array, the loader will attempt to find scale
   *  levels with exactly the same size in every source. If matching level(s) are available, the loader will produce a
   *  volume containing all channels from every provided zarr in the order they appear in `urls`. If no matching sets
   *  of scale levels are available, creation fails.
   * @param scenes The index (or indices) of the image pyramid to load from each URL. If `urls` is an array, `scenes`
   *  may either be an array of values corresponding to each URL, or a single value to apply to all URLs.
   *  This value is used to index into the ZARR's `multiscales` array. Default 0.
   * @param cache A cache to use for storing fetched data.
   * @param lowResCache A dedicated cache for the coarsest resolution level.
   * @param queue A queue to use for managing requests. If not provided, a new queue will be created.
   * @param fetchOptions Options to configure (pre)fetching behavior.
   */
  static async createLoader(
    urls: string | string[],
    scenes: number | number[] = 0,
    cache?: VolumeCache,
    lowResCache?: VolumeCache,
    queue?: SubscribableRequestQueue,
    fetchOptions?: ZarrLoaderFetchOptions
  ): Promise<OMEZarrLoader> {
    // Setup queue and store, get basic metadata
    if (!queue) {
      queue = new SubscribableRequestQueue(fetchOptions?.concurrencyLimit, fetchOptions?.prefetchConcurrencyLimit);
    }
    const urlsArr = (Array.isArray(urls) ? urls : [urls]).map(remapUri);
    const scenesArr = Array.isArray(scenes) ? scenes : [scenes];

    // Create one `ZarrSource` per URL
    const sourceProms = urlsArr.map(async (url, i) => {
      const store = new zarr.FetchStore(url, { fetch: relaxedFetch });
      const root = zarr.root(store);

      const group = await zarr
        .open(root, { kind: "group" })
        .catch(wrapVolumeLoadError(`Failed to open OME-Zarr data at ${url}`, VolumeLoadErrorType.NOT_FOUND));

      const sourceName = urlsArr.length > 1 ? `Zarr source ${i}` : "Zarr";
      const meta = toOMEZarrMetaV4(group.attrs);
      assertMetadataHasMultiscales(meta, sourceName);

      // Pick scene (multiscale)
      let scene = scenesArr[Math.min(i, scenesArr.length - 1)];
      if (scene > meta.multiscales?.length) {
        console.warn(`WARNING: OMEZarrLoader: scene ${scene} is invalid. Using scene 0.`);
        scene = 0;
      }

      validateOMEZarrMetadata(meta, scene, sourceName);

      const { multiscales, omero } = meta;
      const multiscaleMetadata = multiscales[scene];

      // Open all scale levels of multiscale
      const lvlProms = multiscaleMetadata.datasets.map(({ path }) =>
        zarr
          .open(root.resolve(path), { kind: "array" })
          .catch(
            wrapVolumeLoadError(
              `Failed to open scale level ${path} of OME-Zarr data at ${url}`,
              VolumeLoadErrorType.NOT_FOUND
            )
          )
      );
      const scaleLevels = (await Promise.all(lvlProms)) as NumericZarrArray[];
      const axesTCZYX = remapAxesToTCZYX(multiscaleMetadata.axes);

      return {
        scaleLevels,
        baseUrl: url,
        multiscaleMetadata,
        omeroMetadata: omero,
        axesTCZYX,
        channelOffset: 0,
      } as ZarrSource;
    });
    const sources = await Promise.all(sourceProms);

    // Set `channelOffset`s so we can match channel indices to sources
    let channelCount = 0;
    for (const s of sources) {
      s.channelOffset = channelCount;
      if (s.omeroMetadata !== undefined) {
        channelCount += s.omeroMetadata.channels.length;
      } else if (s.axesTCZYX[1] > -1) {
        channelCount += s.scaleLevels[0].shape[s.axesTCZYX[1]];
      } else {
        channelCount += 1;
      }
    }
    // Ensure the sizes of all sources' scale levels are matched up. See this function's docs for more.
    matchSourceScaleLevels(sources);
    // TODO: if `matchSourceScaleLevels` returned successfully, every one of these sources' `multiscaleMetadata` is the
    // same in every field we care about, so we only ever use the first source's `multiscaleMetadata` after this point.
    // Should we only store one `OMEMultiscale` record total, rather than one per source?
    const priorityDirs = fetchOptions?.priorityDirections ? fetchOptions.priorityDirections.slice() : undefined;

    // Only use a low-res cache if there are multiple resolution levels available
    // Use sources[0] because matchSourceScaleLevels made all sources[i].scaleLevels identical
    const resolvedLowResCache = sources[0].scaleLevels.length > 1 ? lowResCache : undefined;
    return new OMEZarrLoader(sources, queue, cache, resolvedLowResCache, fetchOptions, priorityDirs);
  }

  private getUnitSymbols(): [string, string] {
    const source = this.sources[0];
    // Assume all spatial axes in all sources have the same units - we have no means of storing per-axis unit symbols
    const xi = source.axesTCZYX[4];
    const spaceUnitName = source.multiscaleMetadata.axes[xi].unit;
    const spaceUnitSymbol = unitNameToSymbol(spaceUnitName) || spaceUnitName || "";

    const ti = source.axesTCZYX[0];
    const timeUnitName = ti > -1 ? source.multiscaleMetadata.axes[ti].unit : undefined;
    const timeUnitSymbol = unitNameToSymbol(timeUnitName) || timeUnitName || "";

    return [spaceUnitSymbol, timeUnitSymbol];
  }

  private getLevelShapesZYX(): [number, number, number][] {
    const source = this.sources[0];
    const [z, y, x] = source.axesTCZYX.slice(-3);
    return source.scaleLevels.map(({ shape }) => [z === -1 ? 1 : shape[z], shape[y], shape[x]]);
  }

  private getScale(level: number): TCZYX<number> {
    return getScale(this.sources[0].multiscaleMetadata.datasets[level], this.sources[0].axesTCZYX);
  }

  /**
   * Reorder an input array [T, C, Z, Y, X] based on the dimension order of the specified source.
   * In general, the sourceIdx should be provided, since `matchSourceScaleLevels` does not guarantee
   * that sources have the same axes.
   */
  private orderByDimension<T>(valsTCZYX: TCZYX<T>, sourceIdx = 0): T[] {
    return orderByDimension(valsTCZYX, this.sources[sourceIdx].axesTCZYX);
  }

  private orderByTCZYX<T>(valsDimension: T[], defaultValue: T, sourceIdx = 0): TCZYX<T> {
    return orderByTCZYX(valsDimension, this.sources[sourceIdx].axesTCZYX, defaultValue);
  }

  /**
   * Converts a volume channel index to the index of its zarr source and its channel index within that zarr.
   * e.g., if the loader has 2 sources, the first with 3 channels and the second with 2, then `matchChannelToSource(4)`
   * returns `[1, 1]` (the second channel of the second source).
   */
  private matchChannelToSource(absoluteChannelIndex: number): { sourceIndex: number; channelIndexInSource: number } {
    const lastSrcIdx = this.sources.length - 1;
    const lastSrc = this.sources[lastSrcIdx];
    const lastSrcNumChannels = lastSrc.scaleLevels[0].shape[lastSrc.axesTCZYX[1]];

    const maxChannelIndex = lastSrc.channelOffset + lastSrcNumChannels;
    if (absoluteChannelIndex > maxChannelIndex) {
      throw new VolumeLoadError(
        `Volume channel index ${absoluteChannelIndex} out of range (${maxChannelIndex} channels available)`,
        { type: VolumeLoadErrorType.INVALID_METADATA }
      );
    }

    const firstGreaterIdx = this.sources.findIndex((src) => src.channelOffset > absoluteChannelIndex);
    const sourceIndex = firstGreaterIdx === -1 ? lastSrcIdx : firstGreaterIdx - 1;
    const channelIndexInSource = absoluteChannelIndex - this.sources[sourceIndex].channelOffset;
    return { sourceIndex, channelIndexInSource };
  }

  /**
   * Change which directions to prioritize when prefetching. All chunks will be prefetched in these directions before
   * any chunks are prefetched in any other directions.
   */
  setPrefetchPriority(directions: PrefetchDirection[]): void {
    this.priorityDirections = directions;
  }

  syncMultichannelLoading(sync: boolean): void {
    this.syncChannels = sync;
  }

  updateFetchOptions(options: Partial<ZarrLoaderFetchOptions>): void {
    this.fetchOptions = { ...this.fetchOptions, ...options };
  }

  loadDims(loadSpec: LoadSpec): Promise<VolumeDims[]> {
    const [spaceUnit, timeUnit] = this.getUnitSymbols();
    // Compute subregion size so we can factor that in
    const maxExtent = this.maxExtent ?? new Box3(new Vector3(0, 0, 0), new Vector3(1, 1, 1));
    const subregion = composeSubregion(loadSpec.subregion, maxExtent);
    const regionSize = subregion.getSize(new Vector3());
    const regionArr = [1, 1, regionSize.z, regionSize.y, regionSize.x];

    const result = this.sources[0].scaleLevels.map((level, i) => {
      const scale = this.getScale(i);
      const dims: VolumeDims = {
        spaceUnit: spaceUnit,
        timeUnit: timeUnit,
        shape: this.orderByTCZYX(level.shape, 1).map((val, idx) =>
          Math.max(Math.ceil(val * regionArr[idx]), 1)
        ) as TCZYX<number>,
        spacing: this.orderByTCZYX(scale, 1),
        dataType: level.dtype,
      };
      return dims;
    });

    return Promise.resolve(result);
  }

  createImageInfo(loadSpec: LoadSpec): Promise<LoadedVolumeInfo> {
    // We ensured most info (dims, chunks, etc.) matched between sources earlier, so we can just use the first source.
    const source0 = this.sources[0];
    const [t, , z, y, x] = source0.axesTCZYX;
    const hasT = t > -1;
    const hasZ = z > -1;

    const levelToLoad = pickLevelToLoad(loadSpec, this.getLevelShapesZYX());
    const shapeLv = source0.scaleLevels[levelToLoad].shape;

    const [spatialUnit, timeUnit] = this.getUnitSymbols();

    const numChannelsPerSource: number[] = [];
    for (let i = 0; i < this.sources.length; i++) {
      const source = this.sources[i];
      const cIndex = source.axesTCZYX[1];
      const sourceChannelCount = cIndex > -1 ? source.scaleLevels[levelToLoad].shape[cIndex] : 1;
      numChannelsPerSource.push(sourceChannelCount);
    }

    // we need to make sure that the corresponding matched shapes
    // use the min size of T
    if (hasT) {
      let times = shapeLv[t];
      for (let i = 0; i < this.sources.length; i++) {
        const shape = this.sources[i].scaleLevels[levelToLoad].shape;
        const tindex = this.sources[i].axesTCZYX[0];
        if (shape[tindex] < times) {
          console.warn("The number of time points is not consistent across sources: ", shape[tindex], times);
          times = shape[tindex];
        }
      }
    }

    if (!this.maxExtent) {
      this.maxExtent = loadSpec.subregion.clone();
    }

    // from source 0:
    const pxDimsLv = convertSubregionToPixels(
      loadSpec.subregion,
      new Vector3(shapeLv[x], shapeLv[y], hasZ ? shapeLv[z] : 1)
    );
    const pxSizeLv = pxDimsLv.getSize(new Vector3());

    const atlasTileDims = computePackedAtlasDims(pxSizeLv.z, pxSizeLv.x, pxSizeLv.y);

    // Channel names is the other place where we have to check every source
    // Track which channel names we've seen so far, so that we can rename them to avoid name collisions
    const channelNamesMap = new Map<string, number>();
    const channelNames: string[] = [];
    const channelColors: ([number, number, number] | undefined)[] = [];
    for (const src of this.sources) {
      const { names, colors } = getSourceChannelMeta(src);

      // Resolve name collisions
      const resolvedNames = names.map((channelName) => {
        const numMatchingChannels = channelNamesMap.get(channelName);

        if (numMatchingChannels !== undefined) {
          // If e.g. we've seen channel "Membrane" once before, rename this one to "Membrane (1)"
          channelNamesMap.set(channelName, numMatchingChannels + 1);
          return `${channelName} (${numMatchingChannels})`;
        } else {
          channelNamesMap.set(channelName, 1);
          return channelName;
        }
      });

      channelNames.push(...resolvedNames);
      channelColors.push(...colors);
    }

    const alldims: VolumeDims[] = source0.scaleLevels.map((level, i) => {
      const dims = {
        spaceUnit: spatialUnit,
        timeUnit: timeUnit,
        shape: this.orderByTCZYX(level.shape, 1),
        spacing: this.getScale(i),
        dataType: level.dtype,
      };
      return dims;
    });

    const imgdata: ImageInfo = {
      name: source0.omeroMetadata?.name,

      atlasTileDims: [atlasTileDims.x, atlasTileDims.y],
      subregionSize: [pxSizeLv.x, pxSizeLv.y, pxSizeLv.z],
      subregionOffset: [0, 0, 0],

      numChannelsPerSource,
      channelNames,
      channelColors,
      multiscaleLevel: levelToLoad,
      multiscaleLevelDims: alldims,

      transform: {
        translation: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
    };

    // The `LoadSpec` passed in at this stage should represent the subset which this loader loads, not that
    // which the volume contains. The volume contains the full extent of the subset recognized by this loader.
    const fullExtentLoadSpec: LoadSpec = {
      ...loadSpec,
      subregion: new Box3(new Vector3(0, 0, 0), new Vector3(1, 1, 1)),
    };

    return Promise.resolve({ imageInfo: imgdata, loadSpec: fullExtentLoadSpec });
  }

  private prefetchChunk(
    sourceIndex: number,
    scaleLevel: NumericZarrArray,
    coords: TCZYX<number>,
    subscriber: SubscriberId,
    forLowResCache = false
  ): void {
    const source = this.sources[sourceIndex];
    const instrumented = withVoleInstrumentation(scaleLevel, {
      baseUrl: source.baseUrl,
      cache: this.cache,
      lowResCache: this.lowResCache,
      queue: this.requestQueue,
      subscriber,
      isPrefetch: true,
      forLowResCache,
    });
    // Calling `get` and doing nothing with the result still triggers a cache check, fetch, and insertion
    instrumented
      .getChunk(this.orderByDimension(coords, sourceIndex))
      .catch(
        wrapVolumeLoadError(
          `Unable to prefetch chunk with coords ${coords.join(", ")}`,
          VolumeLoadErrorType.LOAD_DATA_FAILED,
          CHUNK_REQUEST_CANCEL_REASON
        )
      );
  }

  /** Reads a list of chunk keys requested by a `loadVolumeData` call and sets up appropriate prefetch requests. */
  private beginPrefetch(keys: ZarrChunkFetchInfo[], scaleLevel: number): void {
    this.beginLowResPrefetch();

    // Convert keys to arrays of coords
    if (keys.length === 0) {
      return;
    }

    const chunkCoords = keys.map(({ sourceIdx, coords }) => {
      const sourceCoords = this.orderByTCZYX(coords, 0, sourceIdx);
      // Convert source channel index to absolute channel index for `ChunkPrefetchIterator`'s benefit
      // (we match chunk coordinates output from `ChunkPrefetchIterator` back to sources below)
      sourceCoords[1] += this.sources[sourceIdx].channelOffset;
      return sourceCoords;
    });

    // Get number of chunks per dimension in every source array
    const chunkDimsTCZYX = this.sources.map((source, sourceIndex) => {
      const level = source.scaleLevels[scaleLevel];
      const chunkDimsUnordered = level.shape.map((dim, idx) => Math.ceil(dim / level.chunks[idx]));
      return this.orderByTCZYX(chunkDimsUnordered, 1, sourceIndex);
    });

    // `ChunkPrefetchIterator` yields chunk coordinates in order of roughly how likely they are to be loaded next
    const prefetchIterator = new ChunkPrefetchIterator(
      chunkCoords,
      this.fetchOptions.maxPrefetchDistance,
      chunkDimsTCZYX,
      this.priorityDirections,
      this.fetchOptions.onlyPriorityDirections
    );

    const subscriber = this.requestQueue.addSubscriber();
    let prefetchCount = 0;
    for (const chunk of prefetchIterator) {
      if (prefetchCount >= this.fetchOptions.maxPrefetchChunks) {
        break;
      }
      // Match absolute channel coordinate back to source index and channel index
      const { sourceIndex, channelIndexInSource } = this.matchChannelToSource(chunk[1]);
      const source = this.sources[sourceIndex];
      const sourceScaleLevel = source.scaleLevels[scaleLevel];
      chunk[1] = channelIndexInSource;

      this.prefetchChunk(sourceIndex, sourceScaleLevel, chunk, subscriber);
      prefetchCount++;
    }

    // Clear out old prefetch requests (requests that the new `subscriber` listens to will be
    // preserved because they still have a subscriber.)
    if (this.prefetchSubscriber !== undefined) {
      this.requestQueue.removeSubscriber(this.prefetchSubscriber, CHUNK_REQUEST_CANCEL_REASON);
    }
    this.prefetchSubscriber = subscriber;
  }

  private updateImageInfoForLoad(imageInfo: ImageInfo, loadSpec: LoadSpec): ImageInfo {
    // Apply `this.maxExtent` to subregion, if it exists
    const maxExtent = this.maxExtent ?? new Box3(new Vector3(0, 0, 0), new Vector3(1, 1, 1));
    const subregion = composeSubregion(loadSpec.subregion, maxExtent);

    // Pick the level to load based on the subregion size
    const multiscaleLevel = pickLevelToLoad({ ...loadSpec, subregion }, this.getLevelShapesZYX());
    const array0Shape = this.sources[0].scaleLevels[multiscaleLevel].shape;

    // Convert subregion to volume voxels
    const [z, y, x] = this.sources[0].axesTCZYX.slice(2);
    const regionPx = convertSubregionToPixels(
      subregion,
      new Vector3(array0Shape[x], array0Shape[y], z === -1 ? 1 : array0Shape[z])
    );

    // Derive other image info properties from subregion and level to load
    const subregionSize = regionPx.getSize(new Vector3());
    const atlasTileDims = computePackedAtlasDims(subregionSize.z, subregionSize.x, subregionSize.y);

    return {
      ...imageInfo,
      atlasTileDims: [atlasTileDims.x, atlasTileDims.y],
      subregionSize: [subregionSize.x, subregionSize.y, subregionSize.z],
      subregionOffset: [regionPx.min.x, regionPx.min.y, regionPx.min.z],
      multiscaleLevel,
    };
  }

  private beginLowResPrefetch(): void {
    if (!this.lowResCache || this.lowResWarmSubscriber !== undefined) {
      // Low-res warming is only started once
      return;
    }

    this.lowResWarmSubscriber = this.requestQueue.addSubscriber();
    const { plan, availableBytes } = planLowResPrefetch(this.sources, this.lowResCache.maxSize, MINIMUM_LOW_RES_CACHED_EXTENT);
    for (const { sourceIndex, level, coords } of plan) {
      const coordsTCZYX = this.orderByTCZYX(coords, 0, sourceIndex);
      this.prefetchChunk(sourceIndex, level, coordsTCZYX, this.lowResWarmSubscriber, true);
    }
    if (plan.length > 0) {
      console.info(`Prefetching ${plan.length} low-res chunks. ${(this.lowResCache.maxSize - availableBytes)/1_000_000}MB will be used.`);
    }
  }

  async loadRawChannelData(
    imageInfo: ImageInfo,
    loadSpec: LoadSpec,
    onUpdateMetadata: (imageInfo: ImageInfo) => void,
    onData: RawChannelDataCallback
  ): Promise<void> {
    // This seemingly useless line keeps a stable local copy of `syncChannels` which the async closures below capture
    // so that changes to `this.syncChannels` don't affect the behavior of loads in progress.
    const syncChannels = this.syncChannels;

    const updatedImageInfo = this.updateImageInfoForLoad(imageInfo, loadSpec);
    onUpdateMetadata(updatedImageInfo);
    const { numChannelsPerSource, multiscaleLevel } = updatedImageInfo;
    const combinedNumChannels = numChannelsPerSource.reduce((a, b) => a + b, 0);
    const channelIndexes = loadSpec.channels ?? Array.from({ length: combinedNumChannels }, (_, i) => i);

    const subscriber = this.requestQueue.addSubscriber();

    // Prefetch housekeeping: we want to save keys involved in this load to prefetch later
    const keys: ZarrChunkFetchInfo[] = [];
    const reportChunkBase = (sourceIdx: number, coords: number[], sub: SubscriberId) => {
      if (sub === subscriber) {
        keys.push({ sourceIdx, coords });
      }
    };

    const resultChannelIndices: number[] = [];
    const resultChannelData: TypedArray<zarr.NumberDataType>[] = [];
    const resultChannelDtype: zarr.NumberDataType[] = [];
    const resultChannelRanges: [number, number][] = [];

    const channelPromises = channelIndexes.map(async (ch) => {
      // Build slice spec
      const min = new Vector3(...updatedImageInfo.subregionOffset);
      const max = min.clone().add(new Vector3(...updatedImageInfo.subregionSize));
      const { sourceIndex: sourceIdx, channelIndexInSource: sourceCh } = this.matchChannelToSource(ch);
      const unorderedSpec = [loadSpec.time, sourceCh, slice(min.z, max.z), slice(min.y, max.y), slice(min.x, max.x)];

      const source = this.sources[sourceIdx];
      const level = source.scaleLevels[multiscaleLevel];
      const sliceSpec = this.orderByDimension(unorderedSpec as TCZYX<number | zarr.Slice>, sourceIdx);
      const reportChunk = (coords: number[], sub: SubscriberId) => reportChunkBase(sourceIdx, coords, sub);
      const instrumented = withVoleInstrumentation(level, {
        baseUrl: source.baseUrl,
        cache: this.cache,
        lowResCache: this.lowResCache,
        queue: this.requestQueue,
        subscriber,
        reportChunk,
      });

      const result = await zarr.get(instrumented, sliceSpec).catch<zarr.Chunk<zarr.NumberDataType>>((e) => {
        if (e === CHUNK_REQUEST_CANCEL_REASON) {
          return e;
        }
        if (e instanceof VolumeLoadError) {
          throw e;
        }
        const msg =
          e instanceof RangeError
            ? "Could not allocate enough memory for the requested OME-Zarr data"
            : "Could not load OME-Zarr volume data";
        const type = e instanceof RangeError ? VolumeLoadErrorType.TOO_LARGE : VolumeLoadErrorType.LOAD_DATA_FAILED;
        throw new VolumeLoadError(msg, { type, cause: e });
      });

      if (result?.data === undefined) {
        return;
      }

      const converted = convertChannel(result.data as TypedArray, level.dtype);
      if (syncChannels) {
        resultChannelDtype.push(converted.dtype);
        resultChannelData.push(converted.data);
        resultChannelIndices.push(ch);
        resultChannelRanges.push([converted.min, converted.max]);
      } else {
        onData([ch], [converted.dtype], [converted.data], [[converted.min, converted.max]]);
      }
    });

    // Cancel any in-flight requests from previous loads that aren't useful to this one
    if (this.loadSubscriber !== undefined) {
      this.requestQueue.removeSubscriber(this.loadSubscriber, CHUNK_REQUEST_CANCEL_REASON);
    }
    this.loadSubscriber = subscriber;

    this.beginPrefetch(keys, multiscaleLevel);

    await Promise.all(channelPromises);

    if (syncChannels) {
      onData(resultChannelIndices, resultChannelDtype, resultChannelData, resultChannelRanges);
    }

    this.requestQueue.removeSubscriber(subscriber, CHUNK_REQUEST_CANCEL_REASON);
  }
}

export { OMEZarrLoader };
