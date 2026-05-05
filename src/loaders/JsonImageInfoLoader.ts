import {
  ThreadableVolumeLoader,
  type LoadSpec,
  type RawChannelDataCallback,
  type LoadedVolumeInfo,
} from "./IVolumeLoader.js";
import { computeAtlasSize, type ImageInfo } from "../ImageInfo.js";
import type { VolumeDims } from "../VolumeDims.js";
import VolumeCache, { isChunk } from "../VolumeCache.js";
import type { TypedArray, NumberType } from "../types.js";
import { getDataRange } from "../utils/num_utils.js";
import { remapUri } from "../utils/url_utils.js";

interface PackedChannelsImage {
  name: string;
  channels: number[];
}

/* eslint-disable @typescript-eslint/naming-convention */
type JsonImageInfo = {
  name: string;
  version?: string;
  images: PackedChannelsImage[];

  /** X size of the *original* (not downsampled) volume, in pixels */
  width: number;
  /** Y size of the *original* (not downsampled) volume, in pixels */
  height: number;
  /** Number of rows of z-slice tiles (not pixels) in the texture atlas */
  rows: number;
  /** Number of columns of z-slice tiles (not pixels) in the texture atlas */
  cols: number;
  /** Width of a single atlas tile in pixels */
  tile_width: number;
  /** Height of a single atlas tile in pixels */
  tile_height: number;
  /** Width of the texture atlas in pixels; equivalent to `tile_width * cols` */
  atlas_width: number;
  /** Height of the texture atlas in pixels; equivalent to `tile_height * rows` */
  atlas_height: number;
  /** Number of tiles in the texture atlas (or number of z-slices in the volume segment) */
  tiles: number;
  /** Physical x size of a single *original* (not downsampled) pixel */
  pixel_size_x: number;
  /** Physical y size of a single *original* (not downsampled) pixel */
  pixel_size_y: number;
  /** Physical z size of a single pixel */
  pixel_size_z: number;
  /** Symbol of physical unit used by `pixel_size_(x|y|z)` fields */
  pixel_size_unit?: string;

  channels: number;
  channel_names: string[];
  channel_colors?: [number, number, number][];

  times?: number;
  time_scale?: number;
  time_unit?: string;

  // TODO should be optional?
  transform: {
    translation: [number, number, number];
    rotation: [number, number, number];
  };
  userData?: Record<string, unknown>;
};
/* eslint-enable @typescript-eslint/naming-convention */

const rescalePixelSize = (json: JsonImageInfo): [number, number, number] => {
  // the pixel_size_x/y/z are the physical size of the original pixels represented by
  // width and height.  We need to get a physical pixel size that is consistent
  // with the tile_width and tile_height.
  const px = (json.pixel_size_x * json.width) / json.tile_width;
  const py = (json.pixel_size_y * json.height) / json.tile_height;
  const pz = json.pixel_size_z;
  return [px, py, pz];
};

const convertImageInfo = (json: JsonImageInfo): ImageInfo => {
  const [px, py, pz] = rescalePixelSize(json);
  // translation is in pixels that are in the space of json.width, json.height.
  // We need to convert this to the space of the tile_width and tile_height.
  const tr: [number, number, number] = json.transform?.translation ?? [0, 0, 0];
  tr[0] = (tr[0] * json.tile_width) / json.width;
  tr[1] = (tr[1] * json.tile_height) / json.height;
  return {
    name: json.name,
    atlasTileDims: [json.cols, json.rows],
    subregionSize: [json.tile_width, json.tile_height, json.tiles],
    subregionOffset: [0, 0, 0],
    numChannelsPerSource: json.images.map((image) => image.channels.length),
    channelNames: json.channel_names,
    channelColors: json.channel_colors,
    multiscaleLevel: 0,
    multiscaleLevelDims: [
      {
        shape: [json.times || 1, json.channels, json.tiles, json.tile_height, json.tile_width],
        spacing: [json.time_scale || 1, 1, pz, py, px],
        spaceUnit: json.pixel_size_unit || "μm",
        timeUnit: json.time_unit || "s",
        dataType: "uint8",
      },
    ],

    transform: {
      translation: tr,
      rotation: json.transform?.rotation ? json.transform.rotation : [0, 0, 0],
      scale: [1, 1, 1],
    },

    userData: {
      ...json.userData,
      // for metadata display reasons
      originalVolumeSize: [json.width, json.height, json.tiles],
      originalPhysicalPixelSize: [json.pixel_size_x, json.pixel_size_y, json.pixel_size_z],
    },
  };
};

class JsonImageInfoLoader extends ThreadableVolumeLoader {
  urls: string[];
  jsonInfo: (JsonImageInfo | undefined)[];
  syncChannels = false;

  cache?: VolumeCache;

  constructor(urls: string | string[], cache?: VolumeCache) {
    super();

    if (Array.isArray(urls)) {
      this.urls = urls;
    } else {
      this.urls = [urls];
    }

    this.jsonInfo = new Array(this.urls.length);
    this.cache = cache;
  }

  private async getJsonImageInfo(time: number): Promise<JsonImageInfo> {
    const cachedInfo = this.jsonInfo[time];
    if (cachedInfo) {
      return cachedInfo;
    }

    const response = await fetch(remapUri(this.urls[time]));
    const imageInfo = (await response.json()) as JsonImageInfo;

    imageInfo.pixel_size_unit = imageInfo.pixel_size_unit || "μm";
    imageInfo.times = imageInfo.times || this.urls.length;
    this.jsonInfo[time] = imageInfo;
    return imageInfo;
  }

  syncMultichannelLoading(sync: boolean): void {
    this.syncChannels = sync;
  }

  async loadDims(loadSpec: LoadSpec): Promise<VolumeDims[]> {
    const jsonInfo = await this.getJsonImageInfo(loadSpec.time);

    const [px, py, pz] = rescalePixelSize(jsonInfo);

    const d: VolumeDims = {
      shape: [jsonInfo.times || 1, jsonInfo.channels, jsonInfo.tiles, jsonInfo.tile_height, jsonInfo.tile_width],
      spacing: [1, 1, pz, py, px],
      spaceUnit: jsonInfo.pixel_size_unit ?? "μm",
      dataType: "uint8",
      timeUnit: jsonInfo.time_unit ?? "s",
    };
    return [d];
  }

  async createImageInfo(loadSpec: LoadSpec): Promise<LoadedVolumeInfo> {
    const jsonInfo = await this.getJsonImageInfo(loadSpec.time);
    return { imageInfo: convertImageInfo(jsonInfo), loadSpec };
  }

  async loadRawChannelData(
    imageInfo: ImageInfo,
    loadSpec: LoadSpec,
    onUpdateMetadata: (imageInfo: undefined, loadSpec?: LoadSpec) => void,
    onData: RawChannelDataCallback
  ): Promise<void> {
    // if you need to adjust image paths prior to download,
    // now is the time to do it.
    // Try to figure out the urlPrefix from the LoadSpec.
    // For this format we assume the image data is in the same directory as the json file.
    const jsonInfo = await this.getJsonImageInfo(loadSpec.time);

    let images = jsonInfo?.images;
    if (!images) {
      return;
    }

    const requestedChannels = loadSpec.channels;
    if (requestedChannels) {
      // If only some channels are requested, load only images which contain at least one requested channel
      images = images.filter(({ channels }) => channels.some((ch) => requestedChannels.includes(ch)));
    }

    // This regex removes everything after the last slash, so the url had better be simple.
    const urlPrefix = this.urls[loadSpec.time].replace(/[^/]*$/, "");
    images = images.map((element) => ({ ...element, name: urlPrefix + element.name }));

    // Update `image`'s `loadSpec` before loading
    const adjustedLoadSpec: LoadSpec = {
      ...loadSpec,
      // `subregion` and `multiscaleLevel` are unused by this loader
      subregion: { min: [0, 0, 0], max: [1, 1, 1] },
      multiscaleLevel: 0,
      // include all channels in any loaded images
      channels: images.flatMap(({ channels }) => channels),
    };
    onUpdateMetadata(undefined, adjustedLoadSpec);

    const [w, h] = computeAtlasSize(imageInfo);
    const wrappedOnData = (
      ch: number[],
      dtype: NumberType[],
      data: TypedArray<NumberType>[],
      ranges: [number, number][]
    ) => onData(ch, dtype, data, ranges, [w, h]);
    await JsonImageInfoLoader.loadVolumeAtlasData(images, wrappedOnData, this.cache, this.syncChannels);
  }

  /**
   * load per-channel volume data from a batch of image files containing the volume slices tiled across the images
   * @param {Array.<{name:string, channels:Array.<number>}>} imageArray
   * @param {RawChannelDataCallback} onData Per-channel callback. Called when each channel's atlased volume data is loaded
   * @param {VolumeCache} cache
   * @example loadVolumeAtlasData([{
   *     "name": "AICS-10_5_5.ome.tif_atlas_0.png",
   *     "channels": [0, 1, 2]
   * }, {
   *     "name": "AICS-10_5_5.ome.tif_atlas_1.png",
   *     "channels": [3, 4, 5]
   * }, {
   *     "name": "AICS-10_5_5.ome.tif_atlas_2.png",
   *     "channels": [6, 7, 8]
   * }], mycallback);
   */
  static async loadVolumeAtlasData(
    imageArray: PackedChannelsImage[],
    onData: RawChannelDataCallback,
    cache?: VolumeCache,
    syncChannels = false
  ): Promise<void> {
    const resultChannelIndices: number[] = [];
    const resultChannelDtype: NumberType[] = [];
    const resultChannelData: TypedArray<NumberType>[] = [];
    const resultChannelRanges: [number, number][] = [];

    const imagePromises = imageArray.map(async (image) => {
      // Because the data is fetched such that one fetch returns a whole batch,
      // if any in batch is cached then they all should be. So if any in batch is NOT cached,
      // then we will have to do a batch request. This logic works both ways because it's all or nothing.
      let cacheHit = true;
      for (let j = 0; j < Math.min(image.channels.length, 4); ++j) {
        const chindex = image.channels[j];
        const cacheResult = cache?.get(`${image.name}/${chindex}`);
        if (cacheResult && !isChunk(cacheResult)) {
          // all data coming from this loader is natively 8-bit
          const channelData = new Uint8Array(cacheResult);
          if (syncChannels) {
            // if we are synchronizing channels, we need to keep track of the data
            resultChannelIndices.push(chindex);
            resultChannelDtype.push("uint8");
            resultChannelData.push(channelData);
            resultChannelRanges.push(getDataRange(channelData));
          } else {
            onData([chindex], ["uint8"], [channelData], [getDataRange(channelData)]);
          }
        } else {
          cacheHit = false;
          // we can stop checking because we know we are going to have to fetch the whole batch
          break;
        }
      }

      // if all channels were in cache then we can move on to the next
      // image (batch) without requesting
      if (cacheHit) {
        return;
      }

      const response = await fetch(remapUri(image.name), { mode: "cors" });
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);

      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D | null;
      if (!ctx) {
        console.log("Error creating canvas 2d context for " + image.name);
        return;
      }
      ctx.globalCompositeOperation = "copy";
      ctx.globalAlpha = 1.0;
      ctx.drawImage(bitmap, 0, 0);
      const iData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);

      const channelsBits: Uint8Array<ArrayBuffer>[] = [];
      const length = bitmap.width * bitmap.height;

      // allocate channels in batch
      for (let ch = 0; ch < Math.min(image.channels.length, 4); ++ch) {
        channelsBits.push(new Uint8Array(length));
      }

      // extract the data
      const channelRange: [number, number][] = [];
      for (let j = 0; j < Math.min(image.channels.length, 4); ++j) {
        let rawMin = Infinity;
        let rawMax = -Infinity;
        for (let px = 0; px < length; px++) {
          channelsBits[j][px] = iData.data[px * 4 + j];
          rawMin = Math.min(rawMin, channelsBits[j][px]);
          rawMax = Math.max(rawMax, channelsBits[j][px]);
        }
        channelRange[j] = [rawMin, rawMax];
      }

      // done with `iData` and `canvas` now.

      for (let ch = 0; ch < Math.min(image.channels.length, 4); ++ch) {
        const chindex = image.channels[ch];
        cache?.insert(`${image.name}/${chindex}`, channelsBits[ch]);
        // NOTE: the atlas dimensions passed in here are currently unused by `JSONImageInfoLoader`
        // all data coming from this loader is natively 8-bit
        if (syncChannels) {
          resultChannelIndices.push(chindex);
          resultChannelDtype.push("uint8");
          resultChannelData.push(channelsBits[ch]);
          resultChannelRanges.push(channelRange[ch]);
        } else {
          onData([chindex], ["uint8"], [channelsBits[ch]], [channelRange[ch]], [bitmap.width, bitmap.height]);
        }
      }
    });

    await Promise.all(imagePromises);
    if (syncChannels) {
      onData(resultChannelIndices, resultChannelDtype, resultChannelData, resultChannelRanges);
    }
  }
}

export { JsonImageInfoLoader };
