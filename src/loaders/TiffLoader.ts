import { fromUrl, type GeoTIFF, type GeoTIFFImage } from "geotiff";
import { ErrorObject, deserializeError } from "serialize-error";

import { VolumeLoader, LoadSpec, type RawChannelDataCallback, type LoadedVolumeInfo } from "./VolumeLoader.js";
import { computePackedAtlasDims, MAX_ATLAS_EDGE } from "./VolumeLoaderUtils.js";
import { VolumeLoadError, VolumeLoadErrorType, wrapVolumeLoadError } from "./VolumeLoadError.js";
import { type ImageInfo, CImageInfo } from "../ImageInfo.js";
import type { VolumeDims } from "../VolumeDims.js";
import { TypedArray, NumberType } from "../types.js";
import { remapUri } from "../utils/url_utils.js";

function trimNull(xml: string | undefined): string | undefined {
  // trim trailing unicode zeros?
  return xml && xml.trim().replace(/\0/g, "").trim();
}

function getOME(xml: string | undefined): Element | undefined {
  if (typeof xml !== "string") {
    return undefined;
  }

  const parser = new DOMParser();

  try {
    const xmlDoc = parser.parseFromString(xml, "text/xml");
    return xmlDoc.getElementsByTagName("OME")[0];
  } catch {
    return undefined;
  }
}

class OMEDims {
  name: string | undefined = undefined;
  sizex = 0;
  sizey = 0;
  sizez = 1;
  sizec = 1;
  sizet = 1;
  unit = "";
  pixeltype = "";
  dimensionorder = "";
  pixelsizex = 1;
  pixelsizey = 1;
  pixelsizez = 1;
  channelnames: string[] = [];
}

function getDtype(omepixeltype: string): NumberType {
  const mapping: Record<string, NumberType> = {
    uint8: "uint8",
    uint16: "uint16",
    uint32: "uint32",
    int8: "int8",
    int16: "int16",
    int32: "int32",
    float: "float32",
  };
  const dtype = mapping[omepixeltype];
  if (dtype === undefined) {
    console.warn(`Unsupported OME pixel type ${omepixeltype}; defaulting to uint8`);
    return "uint8";
  }
  return dtype;
}

export type TiffWorkerParams = {
  channel: number;
  tilesizex: number;
  tilesizey: number;
  sizec: number;
  sizez: number;
  dimensionOrder: string;
  bytesPerSample: number;
  url: string;
};

export type TiffLoadResult = {
  isError: false;
  data: TypedArray<NumberType>;
  dtype: NumberType;
  channel: number;
  range: [number, number];
};

function getAttributeOrError(el: Element, attr: string): string {
  const val = el.getAttribute(attr);
  if (val === null) {
    throw new VolumeLoadError(`Missing attribute ${attr} in OME-TIFF metadata`, {
      type: VolumeLoadErrorType.INVALID_METADATA,
    });
  }
  return val;
}

function getOMEDims(imageEl: Element): OMEDims {
  const dims = new OMEDims();

  const pixelsEl = imageEl.getElementsByTagName("Pixels")[0];
  dims.name = imageEl.getAttribute("Name") ?? "";
  dims.sizex = Number(getAttributeOrError(pixelsEl, "SizeX"));
  dims.sizey = Number(getAttributeOrError(pixelsEl, "SizeY"));
  dims.sizez = Number(pixelsEl.getAttribute("SizeZ"));
  dims.sizec = Number(pixelsEl.getAttribute("SizeC"));
  dims.sizet = Number(pixelsEl.getAttribute("SizeT"));
  dims.unit = pixelsEl.getAttribute("PhysicalSizeXUnit") ?? "";
  dims.pixeltype = pixelsEl.getAttribute("Type") ?? "";
  dims.dimensionorder = pixelsEl.getAttribute("DimensionOrder") ?? "XYZCT";
  dims.pixelsizex = Number(pixelsEl.getAttribute("PhysicalSizeX"));
  dims.pixelsizey = Number(pixelsEl.getAttribute("PhysicalSizeY"));
  dims.pixelsizez = Number(pixelsEl.getAttribute("PhysicalSizeZ"));
  const channelsEls = pixelsEl.getElementsByTagName("Channel");
  for (let i = 0; i < channelsEls.length; ++i) {
    const name = channelsEls[i].getAttribute("Name");
    const id = channelsEls[i].getAttribute("ID");
    dims.channelnames.push(name ? name : id ? id : "Channel" + i);
  }

  return dims;
}

const getBytesPerSample = (type: string): number => (type === "uint8" ? 1 : type === "uint16" ? 2 : 4);
const getPixelType = (pxSize: number): string => (pxSize === 1 ? "uint8" : pxSize === 2 ? "uint16" : "uint32");

// Despite the class `TiffLoader` extends, this loader is not threadable, since geotiff internally uses features that
// aren't available on workers. It uses its own specialized workers anyways.
class TiffLoader extends VolumeLoader {
  private url: string[];
  dims?: OMEDims;

  constructor(url: string[]) {
    super();
    this.url = url.map(remapUri);
  }

  private async loadOmeDims(): Promise<OMEDims> {
    if (!this.dims) {
      const tiff = await fromUrl(this.url[0], { allowFullFile: true }).catch<GeoTIFF>(
        wrapVolumeLoadError(`Could not open TIFF file at ${this.url[0]}`, VolumeLoadErrorType.NOT_FOUND)
      );
      // DO NOT DO THIS, ITS SLOW
      // const imagecount = await tiff.getImageCount();
      // read the FIRST image
      const image = await tiff
        .getImage()
        .catch<GeoTIFFImage>(wrapVolumeLoadError("Failed to open TIFF image", VolumeLoadErrorType.NOT_FOUND));

      const image0DescriptionRaw: string = image.getFileDirectory().ImageDescription;
      // Get rid of null terminator, if it's there (`JSON.parse` doesn't know what to do with it)
      const image0Description = trimNull(image0DescriptionRaw);
      const omeEl = getOME(image0Description);

      if (omeEl !== undefined) {
        const image0El = omeEl.getElementsByTagName("Image")[0];
        this.dims = getOMEDims(image0El);
      } else {
        console.warn("Could not read OME-TIFF metadata from file. Doing our best with base TIFF metadata.");
        this.dims = new OMEDims();
        let shape: number[] = [];
        if (typeof image0Description === "string") {
          try {
            const description = JSON.parse(image0Description);
            if (Array.isArray(description.shape)) {
              shape = description.shape;
            }
            // eslint-disable-next-line no-empty
          } catch {}
        }

        // if `ImageDescription` is valid JSON with a `shape` field, we expect it to be an array of [t?, c?, z?, y, x].
        this.dims.sizex = shape[shape.length - 1] ?? image.getWidth();
        this.dims.sizey = shape[shape.length - 2] ?? image.getHeight();
        this.dims.sizez = shape[shape.length - 3] ?? (await tiff.getImageCount());

        // TODO this is a big hack/assumption about only loading multi-source tiffs that are not OMETIFF.
        // We really have to check each url in the array for sizec to get the total number of channels
        // See combinedNumChannels in ImageInfo below.
        // Also compare with how OMEZarrLoader does this.
        if (this.url.length > 1) {
          // if multiple urls, assume one channel per url
          this.dims.sizec = this.url.length;
        } else {
          this.dims.sizec = shape[shape.length - 4] ?? 1;
        }

        this.dims.pixeltype = getPixelType(image.getBytesPerPixel());
        this.dims.channelnames = Array.from({ length: this.dims.sizec }, (_, i) => "Channel" + i);
      }
    }
    return this.dims;
  }

  async loadDims(_loadSpec: LoadSpec): Promise<VolumeDims[]> {
    const dims = await this.loadOmeDims();

    const atlasDims = computePackedAtlasDims(dims.sizez, dims.sizex, dims.sizey);
    // fit tiles to max of 2048x2048?
    const targetSize = MAX_ATLAS_EDGE;
    const tilesizex = Math.floor(targetSize / atlasDims.x);
    const tilesizey = Math.floor(targetSize / atlasDims.y);

    const d: VolumeDims = {
      shape: [dims.sizet, dims.sizec, dims.sizez, tilesizey, tilesizex],
      spacing: [
        1,
        1,
        dims.pixelsizez,
        (dims.pixelsizey * dims.sizey) / tilesizey,
        (dims.pixelsizex * dims.sizex) / tilesizex,
      ],
      spaceUnit: dims.unit ? dims.unit : "micron",
      dataType: getDtype(dims.pixeltype),
      timeUnit: "s",
    };
    return [d];
  }

  async createImageInfo(_loadSpec: LoadSpec): Promise<LoadedVolumeInfo> {
    const dims = await this.loadOmeDims();
    // compare with sizex, sizey
    //const width = image.getWidth();
    //const height = image.getHeight();

    // TODO allow user setting of this downsampling info?
    // TODO allow ROI selection: range of x,y,z,c for a given t
    const atlasDims = computePackedAtlasDims(dims.sizez, dims.sizex, dims.sizey);
    // fit tiles to max of 2048x2048?
    const targetSize = MAX_ATLAS_EDGE;
    const tilesizex = Math.floor(targetSize / atlasDims.x);
    const tilesizey = Math.floor(targetSize / atlasDims.y);

    // load tiff and check metadata
    const numChannelsPerSource = this.url.length > 1 ? Array(this.url.length).fill(1) : [dims.sizec];

    const imgdata: ImageInfo = {
      name: dims.name,

      atlasTileDims: [atlasDims.x, atlasDims.y],
      subregionSize: [tilesizex, tilesizey, dims.sizez],
      subregionOffset: [0, 0, 0],
      numChannelsPerSource,
      channelNames: dims.channelnames,
      multiscaleLevel: 0,
      multiscaleLevelDims: [
        {
          shape: [dims.sizet, dims.sizec, dims.sizez, tilesizey, tilesizex],
          spacing: [
            1,
            1,
            dims.pixelsizez,
            (dims.pixelsizey * dims.sizey) / tilesizey,
            (dims.pixelsizex * dims.sizex) / tilesizex,
          ],
          spaceUnit: dims.unit ?? "",
          timeUnit: "",
          dataType: getDtype(dims.pixeltype),
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

  async loadRawChannelData(
    imageInfo: ImageInfo,
    _loadSpec: LoadSpec,
    _onUpdateMetadata: () => void,
    onData: RawChannelDataCallback
  ): Promise<void> {
    const dims = await this.loadOmeDims();

    // get some size info.
    const cimageinfo = new CImageInfo(imageInfo);
    const volumeSize = cimageinfo.volumeSize;

    const channelProms: Promise<void>[] = [];
    // do each channel on a worker?
    for (let source = 0; source < imageInfo.numChannelsPerSource.length; ++source) {
      const numChannels = imageInfo.numChannelsPerSource[source];
      for (let channel = 0; channel < numChannels; ++channel) {
        const thisChannelProm = new Promise<void>((resolve, reject) => {
          const params: TiffWorkerParams = {
            channel: channel,
            // these are target xy sizes for the in-memory volume data
            // they may or may not be the same size as original xy sizes
            tilesizex: volumeSize.x,
            tilesizey: volumeSize.y,
            sizec: numChannels,
            sizez: volumeSize.z,
            dimensionOrder: dims.dimensionorder,
            bytesPerSample: getBytesPerSample(dims.pixeltype),
            url: this.url[source],
          };

          const worker = new Worker(new URL("../workers/FetchTiffWorker", import.meta.url), { type: "module" });
          worker.onmessage = (e: MessageEvent<TiffLoadResult | { isError: true; error: ErrorObject }>) => {
            if (e.data.isError) {
              reject(deserializeError(e.data.error));
              return;
            }
            const { data, dtype, channel, range } = e.data;
            onData([channel], [dtype], [data], [range]);
            worker.terminate();
            resolve();
          };

          worker.postMessage(params);
        });

        channelProms.push(thisChannelProm);
      }
    }

    // waiting for all channels to load allows errors to propagate to the caller via this promise
    await Promise.all(channelProms);
  }
}

export { TiffLoader };
