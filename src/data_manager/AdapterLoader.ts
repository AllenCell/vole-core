import type { ImageInfo } from "../ImageInfo.js";
import type { LoadedVolumeInfo, LoadSpec, RawChannelDataCallback } from "../loaders/IVolumeLoader.js";
import { ThreadableVolumeLoader } from "../loaders/IVolumeLoader.js";
import { VolumeDims } from "../VolumeDims.js";
import DataManager, { IDataSubscriber } from "./data_manager.js";
import { ExtVolumeDims, VolumeMetadata } from "./sources/chunk_source.js";
import type { Chunk, ChunkId } from "./types.js";
import { pickLevelToLoad } from "../loaders/VolumeLoaderUtils.js";

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

  private roundExtentToChunks(loadSpec: LoadSpec, level: number): LoadSpec {
    const { shape, chunkShape } = this.dims[level];
    const [, , sz, sy, sx] = shape;
    const [, , cz, cy, cx] = chunkShape;
    const chunksX = sx / cx;
    const chunksY = sy / cy;
    const chunksZ = sz / cz;

    const {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
    } = loadSpec.subregion;
    const roundMin = (val: number, chunks: number): number => Math.floor(val * chunks) / chunks;
    const roundMax = (val: number, chunks: number): number => Math.min(1, Math.ceil(val * chunks) / chunks);
    const min: [number, number, number] = [roundMin(minX, chunksX), roundMin(minY, chunksY), roundMin(minZ, chunksZ)];
    const max: [number, number, number] = [roundMax(maxX, chunksX), roundMax(maxY, chunksY), roundMax(maxZ, chunksZ)];

    return { ...loadSpec, subregion: { min, max } };
  }

  loadDims(loadSpec: LoadSpec): Promise<VolumeDims[]> {
    return Promise.resolve(this.dims);
  }

  createImageInfo(loadSpec: LoadSpec): Promise<LoadedVolumeInfo> {
    const shapesZYX = this.dims.map(({ shape }) => [shape[2], shape[3], shape[4]] as [number, number, number]);
    // TODO this picks the optimal level to load assuming we will fetch exactly `LoadSpec.subregion`, but this loader
    //   extends `subregion` to the nearest chunk boundaries
    const multiscaleLevel = pickLevelToLoad(loadSpec, shapesZYX);
    const adjustedLoadSpec = this.roundExtentToChunks(loadSpec, multiscaleLevel);

    const imageInfo: ImageInfo = {
      ...this.meta,
      multiscaleLevelDims: this.dims,
      multiscaleLevel,
      atlasTileDims: [],
      subregionSize: [],
      subregionOffset: [],
      // no multi-source support, yet
      numChannelsPerSource: [this.dims[multiscaleLevel].chunkShape[1]],
    };

    return Promise.resolve({ imageInfo, loadSpec: adjustedLoadSpec });
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
