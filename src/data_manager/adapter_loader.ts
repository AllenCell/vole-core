import type { ImageInfo } from "../ImageInfo.js";
import type { LoadedVolumeInfo, LoadSpec, RawChannelDataCallback, Region } from "../loaders/IVolumeLoader.js";
import { ThreadableVolumeLoader } from "../loaders/IVolumeLoader.js";
import { VolumeDims } from "../VolumeDims.js";
import DataManager, { IDataSubscriber } from "./data_manager.js";
import { ExtVolumeDims, VolumeMetadata } from "./sources/chunk_source.js";
import type { Chunk, ChunkId } from "./types.js";
import { computePackedAtlasDims, MAX_ATLAS_EDGE } from "../loaders/VolumeLoaderUtils.js";

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default class AdapterLoader extends ThreadableVolumeLoader implements IDataSubscriber<any> {
  private dims: ExtVolumeDims[];
  private meta: VolumeMetadata;

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private manager: DataManager<any, any>,
    private sourceId: number
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

  // MARK: Helpers

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

  loadRawChannelData(
    imageInfo: ImageInfo,
    loadSpec: LoadSpec,
    onUpdateVolumeMetadata: (imageInfo?: ImageInfo, loadSpec?: LoadSpec) => void,
    onData: RawChannelDataCallback
  ): Promise<void> {
    throw new Error("Method not implemented.");
  }

  onChunkLoaded(id: ChunkId, chunk: Chunk) {}

  destroy() {
    this.manager.unsubscribeFromSource(this, this.sourceId);
  }
}
