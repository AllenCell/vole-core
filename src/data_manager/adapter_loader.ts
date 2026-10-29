import type { ImageInfo } from "../ImageInfo.js";
import type { LoadedVolumeInfo, LoadSpec, RawChannelDataCallback, Region } from "../loaders/IVolumeLoader.js";
import { ThreadableVolumeLoader } from "../loaders/IVolumeLoader.js";
import { VolumeDims } from "../VolumeDims.js";
import DataManager, { IDataSubscriber } from "./data_manager.js";
import { ExtVolumeDims, VolumeMetadata } from "./sources/chunk_source.js";
import { ChunkPriorityLevel, LocalChunkId, type ChunkId } from "./types.js";
import { computePackedAtlasDims, MAX_ATLAS_EDGE } from "../loaders/VolumeLoaderUtils.js";
import { BorrowGuard } from "./task_pool/borrow_guard.js";
import { ARRAY_CONSTRUCTORS, type TypedArray } from "../types.js";
import { TaskPool } from "./task_pool/task_pool.js";
import { getDataRange } from "../utils/num_utils.js";
import { copyChunkTask } from "./index.js";
import type { CopyChunkParams } from "./indexing.js";
import { getChunkDims } from "./utils.js";

// MARK: Utils

type XYZ<T = number> = [T, T, T];
type TCZYX<T = number> = [T, T, T, T, T];

const mapXYZ = <T, U>([x, y, z]: XYZ<T>, f: (a: T) => U): XYZ<U> => [f(x), f(y), f(z)];
const zipXYZ = <T, U, V>([x1, y1, z1]: XYZ<T>, [x2, y2, z2]: XYZ<U>, f: (a: T, b: U) => V): XYZ<V> => [
  f(x1, x2),
  f(y1, y2),
  f(z1, z2),
];
const zipTCZYX = <T, U, V>([x1, y1, z1]: XYZ<T>, [, , z2, y2, x2]: TCZYX<U>, f: (a: T, b: U) => V): XYZ<V> => [
  f(x1, x2),
  f(y1, y2),
  f(z1, z2),
];
const subtract = (a: XYZ, b: XYZ): XYZ => zipXYZ(a, b, (l, r) => l - r);
const equals = ([x1, y1, z1]: XYZ, [x2, y2, z2]: XYZ): boolean => x1 === x2 && y1 === y2 && z1 === z2;

const normalizedPointToVoxel = (point: XYZ, { shape }: ExtVolumeDims): XYZ => zipTCZYX(point, shape, (p, s) => p * s);
const voxelToNormalizedPoint = (voxel: XYZ, { shape }: ExtVolumeDims): XYZ => zipTCZYX(voxel, shape, (v, s) => v / s);

const chunkToVoxel = (chunk: XYZ, { chunkShape, shape }: ExtVolumeDims): XYZ => {
  const rawVoxel = zipTCZYX(chunk, chunkShape, (c, s) => c * s);
  return zipTCZYX(rawVoxel, shape, Math.min);
};
const voxelToChunk = (voxel: XYZ, { chunkShape }: ExtVolumeDims): XYZ =>
  zipTCZYX(voxel, chunkShape, (v, s) => Math.floor(v / s));

const normalizedPointToChunk = (point: XYZ, dims: ExtVolumeDims): XYZ =>
  voxelToChunk(normalizedPointToVoxel(point, dims), dims);

const subregionToChunks = ({ min, max }: Region, dims: ExtVolumeDims): Region => ({
  min: normalizedPointToChunk(min, dims),
  max: mapXYZ(normalizedPointToChunk(max, dims), (n) => n + 1),
});

const contains = ({ min, max }: Region, [x, y, z]: XYZ): boolean => {
  const [minX, minY, minZ] = min;
  const [maxX, maxY, maxZ] = max;
  return minX <= x && minY <= y && minZ <= z && x < maxX && y < maxY && z < maxZ;
};

function* iterRegion({ min, max }: Region): Generator<XYZ> {
  const [minX, minY, minZ] = min;
  const [maxX, maxY, maxZ] = max;
  for (let z = minZ; z < maxZ; z++) {
    for (let y = minY; y < maxY; y++) {
      for (let x = minX; x < maxX; x++) {
        yield [x, y, z];
      }
    }
  }
}

const chunkReceivedIndex = ([x, y, z]: XYZ, { min, max }: Region): number => {
  const [, sizeY, sizeZ] = subtract(max, min);
  return sizeY * sizeZ * z + sizeY * y + x;
};

// MARK: Channel assembler

class ChannelAssembler {
  private chunksReceived: boolean[];
  private shape: XYZ;

  constructor(
    public data: BorrowGuard<TypedArray>,
    private dims: ExtVolumeDims,
    private chunks: Region,
    private onComplete: (data: TypedArray) => void,
    private pool: TaskPool
  ) {
    const [x, y, z] = subtract(chunks.max, chunks.min);
    const chunkCount = x * y * z;
    this.chunksReceived = new Array(chunkCount).fill(false);
    const voxelMin = chunkToVoxel(chunks.min, dims);
    const voxelMax = chunkToVoxel(chunks.max, dims);
    this.shape = subtract(voxelMax, voxelMin);
  }

  private getParams(id: LocalChunkId): CopyChunkParams {
    const chunkDims = getChunkDims(id, this.dims);
    const [, , z, y, x] = id.tczyx;
    const offset = chunkToVoxel([x, y, z], this.dims);
    return {
      srcShape: [chunkDims.x, chunkDims.y, chunkDims.z],
      destShape: this.shape,
      offset,
    };
  }

  async set(id: LocalChunkId, chunk: BorrowGuard<TypedArray>): Promise<void> {
    const [, , z, y, x] = id.tczyx;
    const xyz: XYZ = [x, y, z];
    if (!contains(this.chunks, xyz)) {
      return;
    }

    const receivedIndex = chunkReceivedIndex(xyz, this.chunks);
    if (this.chunksReceived[receivedIndex]) {
      return;
    }
    this.chunksReceived[receivedIndex] = true;

    const params = this.getParams(id);
    await this.pool.runTask(copyChunkTask, chunk, this.data, params);

    if (this.chunksReceived.every((value) => value)) {
      const data = await this.data.getAsync();
      this.onComplete(data);
    }
  }
}

// MARK: Class definition

export default class AdapterLoader extends ThreadableVolumeLoader implements IDataSubscriber {
  private dims: ExtVolumeDims[];
  private meta: VolumeMetadata;
  private channels: Map<number, ChannelAssembler> = new Map();
  private currentExtent: {
    t: number;
    c: number[];
    multiscale: number;
    chunks: Region;
  } = {
    t: 0,
    c: [],
    multiscale: 0,
    chunks: { min: [0, 0, 0], max: [0, 0, 0] },
  };

  constructor(
    private manager: DataManager,
    private sourceId: number,
    private pool: TaskPool
  ) {
    super();
    const dims = manager.getSourceDims(sourceId);
    const meta = manager.getSourceMeta(sourceId);

    if (dims === undefined || meta === undefined) {
      throw new Error(`AdapterLoader: source ${this.sourceId} does not exist`);
    }

    this.dims = dims;
    this.meta = meta;

    manager.subscribeToSource(this, sourceId);
  }

  private pickMultiscaleIndex(loadSpec: LoadSpec): number {
    if (loadSpec.useExplicitLevel && loadSpec.multiscaleLevel !== undefined) {
      return Math.max(0, Math.min(this.dims.length - 1, loadSpec.multiscaleLevel));
    }

    const { subregion } = loadSpec;
    const maxAtlasEdge = loadSpec.maxAtlasEdge ?? MAX_ATLAS_EDGE;
    let i = 0;
    for (; i < this.dims.length; i++) {
      const dims = this.dims[i];
      const chunks = subregionToChunks(subregion, dims);

      const voxelMin = chunkToVoxel(chunks.min, dims);
      const voxelMax = chunkToVoxel(chunks.max, dims);

      const [sizeX, sizeY, sizeZ] = subtract(voxelMax, voxelMin);
      const tilesX = Math.floor(maxAtlasEdge / sizeX);
      const tilesY = Math.floor(maxAtlasEdge / sizeY);
      if (tilesX * tilesY >= sizeZ) {
        break;
      }
    }

    if (i === this.dims.length) {
      // TODO bring in better error message, like equivalent from `VolumeLoaderUtils`
      console.error("Volume is too large!");
      return this.dims.length - 1;
    }

    const adjustedLevel = Math.max(i + (loadSpec.scaleLevelBias ?? 0), loadSpec.multiscaleLevel ?? 0);
    return Math.max(0, Math.min(this.dims.length - 1, adjustedLevel));
  }

  private *iterChunks(c: number): Generator<ChunkId> {
    const source = this.sourceId;
    const { t, multiscale, chunks } = this.currentExtent;
    for (const [x, y, z] of iterRegion(chunks)) {
      const tczyx: TCZYX = [t, c, z, y, x];
      yield { source, multiscale, tczyx };
    }
  }

  private removeChannelRequests(c: number): void {
    for (const id of this.iterChunks(c)) {
      this.manager.removeChunkRequest(this, id);
    }
  }

  private updateExtent(loadSpec: LoadSpec): void {
    const levelToLoad = this.pickMultiscaleIndex(loadSpec);
    const dims = this.dims[levelToLoad];
    const nextChunks = subregionToChunks(loadSpec.subregion, dims);
    const { t, multiscale, chunks } = this.currentExtent;

    if (
      loadSpec.time === t &&
      levelToLoad === multiscale &&
      equals(nextChunks.min, chunks.min) &&
      equals(nextChunks.max, chunks.max)
    ) {
      // We can keep some channel arrays around. Let's see which ones.
      const nextChannels = new Map<number, ChannelAssembler>();
      for (const index of loadSpec.channels ?? []) {
        const channel = this.channels.get(index);
        if (channel !== undefined) {
          this.channels.delete(index);
          nextChannels.set(index, channel);
        }
      }

      for (const index of this.channels.keys()) {
        this.removeChannelRequests(index);
      }

      this.channels = nextChannels;
    }

    // We have to completely replace all channels.
    for (const channel of this.channels.keys()) {
      this.removeChannelRequests(channel);
    }
    this.currentExtent = {
      t,
      c: loadSpec.channels ?? [],
      chunks: nextChunks,
      multiscale: levelToLoad,
    };
    this.channels = new Map();
  }

  // MARK: Loader interface

  loadDims(_loadSpec: LoadSpec): Promise<VolumeDims[]> {
    return Promise.resolve(this.dims);
  }

  createImageInfo(loadSpec: LoadSpec): Promise<LoadedVolumeInfo> {
    const multiscaleLevel = this.pickMultiscaleIndex(loadSpec);
    const dims = this.dims[multiscaleLevel];
    const chunks = subregionToChunks(loadSpec.subregion, dims);
    const voxelMin = chunkToVoxel(chunks.min, dims);
    const voxelMax = chunkToVoxel(chunks.max, dims);
    const subregionSize = subtract(voxelMax, voxelMin);

    const [x, y, z] = subregionSize;
    const atlasTileDims = computePackedAtlasDims(z, x, y).toArray();

    const imageInfo: ImageInfo = {
      name: undefined,
      ...this.meta,
      multiscaleLevelDims: this.dims,
      multiscaleLevel,
      atlasTileDims,
      subregionSize,
      subregionOffset: voxelMin,
      // no multi-source support, yet
      numChannelsPerSource: [this.dims[multiscaleLevel].chunkShape[1]],
    };

    const subregion = {
      min: voxelToNormalizedPoint(voxelMin, dims),
      max: voxelToNormalizedPoint(voxelMax, dims),
    };
    return Promise.resolve({ imageInfo, loadSpec: { ...loadSpec, subregion } });
  }

  async loadRawChannelData(
    imageInfo: ImageInfo,
    loadSpec: LoadSpec,
    onUpdateVolumeMetadata: (imageInfo?: ImageInfo, loadSpec?: LoadSpec) => void,
    onData: RawChannelDataCallback
  ): Promise<void> {
    // TODO update `ImageInfo`? See `OMEZarrLoader`
    this.updateExtent(loadSpec);
    const channels = loadSpec.channels ?? [];
    const { multiscale, chunks } = this.currentExtent;
    const dims = this.dims[multiscale];

    const dtype = this.dims[multiscale].dataType;
    const arrayConstructor = ARRAY_CONSTRUCTORS[dtype];

    const voxelMin = chunkToVoxel(chunks.min, dims);
    const voxelMax = chunkToVoxel(chunks.max, dims);
    const [sizeX, sizeY, sizeZ] = subtract(voxelMax, voxelMin);
    const bufferSize = sizeX * sizeY * sizeZ;

    const channelPromises: Promise<void>[] = [];

    for (const channelIndex of channels) {
      const preservedChannel = this.channels.get(channelIndex);

      // We've already got this channel. Just return it.
      if (preservedChannel !== undefined) {
        const promise = preservedChannel.data
          .getAsync()
          .then((data) => onData([channelIndex], [dtype], [data], [getDataRange(data)]));
        channelPromises.push(promise);
        continue;
      }

      // Build a new channel
      const data = new BorrowGuard(new arrayConstructor(bufferSize));
      let resolve: () => void;
      channelPromises.push(new Promise((r) => (resolve = r)));
      const onComplete = (data: TypedArray): void => {
        onData([channelIndex], [dtype], [data], [getDataRange(data)]);
        resolve();
      };
      const channel = new ChannelAssembler(data, dims, chunks, onComplete, this.pool);
      this.channels.set(channelIndex, channel);

      // Request the chunks in this channel
      for (const chunkId of this.iterChunks(channelIndex)) {
        this.manager.addChunkRequest(this, chunkId, { level: ChunkPriorityLevel.VISIBLE, score: 1000 }, false);
        const chunk = this.manager.getChunkGuard(chunkId);
        if (chunk !== undefined) {
          channel.set(chunkId, chunk);
        }
      }
    }

    await Promise.all(channelPromises);
  }

  onChunkLoaded(id: ChunkId, chunk: BorrowGuard<TypedArray>) {
    const [t, c] = id.tczyx;
    if (t !== this.currentExtent.t) {
      return;
    }

    const channel = this.channels.get(c);
    if (channel === undefined) {
      return;
    }

    channel.set(id, chunk);
  }

  destroy() {
    for (const channelIndex of this.channels.keys()) {
      this.removeChannelRequests(channelIndex);
    }
    this.manager.unsubscribeFromSource(this, this.sourceId);
  }
}
