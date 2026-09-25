import { Box3, Vector3 } from "three";

import type { ImageInfo } from "../ImageInfo.js";
import type { LoadedVolumeInfo, LoadSpec, RawChannelDataCallback } from "../loaders/IVolumeLoader.js";
import { ThreadableVolumeLoader } from "../loaders/IVolumeLoader.js";
import { VolumeDims } from "../VolumeDims.js";
import DataManager, { IDataSubscriber } from "./DataManager.js";
import { ExtVolumeDims, VolumeMetadata } from "./sources/ChunkSource.js";
import type { Chunk, ChunkId } from "./types.js";
import { pickLevelToLoad } from "../loaders/VolumeLoaderUtils.js";

export default class AdapterLoader extends ThreadableVolumeLoader implements IDataSubscriber {
  private dims: ExtVolumeDims[];
  private meta: VolumeMetadata;

  constructor(
    private manager: DataManager,
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
    const chunksPerDim = new Vector3(sx / cx, sy / cy, sz / cz);

    const min = loadSpec.subregion.min.clone().multiply(chunksPerDim).floor().divide(chunksPerDim);
    const max = loadSpec.subregion.max.clone().multiply(chunksPerDim).ceil().divide(chunksPerDim).min(new Vector3(1));
    return { ...loadSpec, subregion: new Box3(min, max) };
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
