import { VolumeLoader, LoadSpec, RawChannelDataCallback, LoadedVolumeInfo } from "./IVolumeLoader.js";
import { computeAtlasSize, type ImageInfo } from "../ImageInfo.js";
import type { VolumeDims } from "../VolumeDims.js";
import { JsonImageInfoLoader } from "./JsonImageInfoLoader.js";
import { getDataRange } from "../utils/num_utils.js";

class OpenCellLoader extends VolumeLoader {
  async loadDims(_: LoadSpec): Promise<VolumeDims[]> {
    const d: VolumeDims = {
      shape: [1, 2, 27, 600, 600],
      spacing: [1, 1, 2, 1, 1],
      spaceUnit: "", // unknown unit.
      dataType: "uint8",
      timeUnit: "",
    };
    return [d];
  }

  async createImageInfo(_loadSpec: LoadSpec): Promise<LoadedVolumeInfo> {
    const numChannels = 2;

    // we know these are standardized to 600x600, two channels, one channel per jpg.
    const chnames: string[] = ["DNA", "Structure"];

    const imgdata: ImageInfo = {
      name: "TEST",

      atlasTileDims: [27, 1],
      subregionSize: [600, 600, 27],
      subregionOffset: [0, 0, 0],
      numChannelsPerSource: [numChannels],
      channelNames: chnames,
      multiscaleLevel: 0,
      multiscaleLevelDims: [
        {
          shape: [1, numChannels, 27, 600, 600],
          spacing: [1, 1, 2, 1, 1],
          spaceUnit: "µm",
          timeUnit: "",
          dataType: "uint8",
        },
      ],

      transform: {
        translation: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
    };

    // This loader uses no fields from `LoadSpec`. Initialize volume with defaults.
    return { imageInfo: imgdata, loadSpec: new LoadSpec() };
  }

  loadRawChannelData(
    imageInfo: ImageInfo,
    _loadSpec: LoadSpec,
    _onUpdateMetadata: () => void,
    onData: RawChannelDataCallback
  ): Promise<void> {
    // HQTILE or LQTILE
    // make a json metadata dict for the two channels:
    const urls = [
      {
        name: "https://opencell.czbiohub.org/data/opencell-microscopy/roi/czML0383-P0007/czML0383-P0007-A02-PML0308-S13_ROI-0424-0025-0600-0600-LQTILE-CH405.jpg",
        channels: [0],
      },
      {
        name: "https://opencell.czbiohub.org/data/opencell-microscopy/roi/czML0383-P0007/czML0383-P0007-A02-PML0308-S13_ROI-0424-0025-0600-0600-LQTILE-CH488.jpg",
        channels: [1],
      },
    ];

    const [w, h] = computeAtlasSize(imageInfo);
    // all data coming from this loader is natively 8-bit
    return JsonImageInfoLoader.loadVolumeAtlasData(urls, (ch, dtype, data) =>
      onData(ch, dtype, data, data.map(getDataRange), [w, h])
    );
  }
}

export { OpenCellLoader };
