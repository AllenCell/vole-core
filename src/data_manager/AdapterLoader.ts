import type { ImageInfo } from "../ImageInfo.js";
import type { LoadedVolumeInfo, LoadSpec, RawChannelDataCallback } from "../loaders/IVolumeLoader.js";
import { ThreadableVolumeLoader } from "../loaders/IVolumeLoader.js";
import { VolumeDims } from "../VolumeDims.js";
import DataManager, { IDataSubscriber } from "./DataManager.js";
import type { Chunk, ChunkId } from "./types.js";

export default class AdapterLoader extends ThreadableVolumeLoader implements IDataSubscriber {
  constructor(
    private manager: DataManager,
    private sourceId: number
  ) {
    super();
    manager.subscribeToSource(this, sourceId);
  }

  loadDims(loadSpec: LoadSpec): Promise<VolumeDims[]> {
    const result = this.manager.getSourceDims(this.sourceId);
    if (result === undefined) {
      throw new Error("AdapterLoader: source does not exist");
    }
    return Promise.resolve(result);
  }

  createImageInfo(loadSpec: LoadSpec): Promise<LoadedVolumeInfo> {
    const imageInfo: ImageInfo = {
      name: undefined,
      atlasTileDims: [],
      subregionSize: [],
      subregionOffset: [],
      numChannelsPerSource: [],
      channelNames: [],
      channelColors: [],
      multiscaleLevelDims: [],
      multiscaleLevel: 0,
      transform: {
        translation: [],
        rotation: [],
        scale: [],
      },
      userData: {},
    };
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
