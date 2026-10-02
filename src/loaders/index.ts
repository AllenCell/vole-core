import { ThreadableVolumeLoader } from "./IVolumeLoader.js";
import { OMEZarrLoader, type ZarrLoaderFetchOptions } from "./OmeZarrLoader.js";
import { JsonImageInfoLoader } from "./JsonImageInfoLoader.js";
import { RawArrayLoader, RawArrayLoaderOptions } from "./RawArrayLoader.js";
import { TiffLoader } from "./TiffLoader.js";
import VolumeCache from "../VolumeCache.js";
import SubscribableRequestQueue from "../utils/SubscribableRequestQueue.js";

export { PrefetchDirection } from "./zarr_utils/types.js";

export const enum VolumeFileFormat {
  ZARR = "zarr",
  JSON = "json",
  TIFF = "tiff",
  DATA = "data",
}

// superset of all necessary loader options
export type CreateLoaderOptions = {
  fileType?: VolumeFileFormat;
  cache?: VolumeCache;
  lowResCache?: VolumeCache;
  queue?: SubscribableRequestQueue;
  scene?: number;
  fetchOptions?: ZarrLoaderFetchOptions;
  rawArrayOptions?: RawArrayLoaderOptions;
};

export function pathToFileType(path: string): VolumeFileFormat {
  if (path.endsWith(".json")) {
    return VolumeFileFormat.JSON;
  } else if (path.endsWith(".tif") || path.endsWith(".tiff")) {
    return VolumeFileFormat.TIFF;
  }
  return VolumeFileFormat.ZARR;
}

export async function createVolumeLoader(
  path: string | string[],
  options?: CreateLoaderOptions
): Promise<ThreadableVolumeLoader> {
  const pathString = Array.isArray(path) ? path[0] : path;
  const fileType = options?.fileType || pathToFileType(pathString);
  const pathArrayForTiffLoader = Array.isArray(path) ? path : [path];

  switch (fileType) {
    case VolumeFileFormat.ZARR:
      return await OMEZarrLoader.createLoader(
        path,
        options?.scene,
        options?.cache,
        options?.queue,
        options?.fetchOptions,
        options?.lowResCache
      );
    case VolumeFileFormat.JSON:
      return new JsonImageInfoLoader(path, options?.cache);
    case VolumeFileFormat.TIFF:
      return new TiffLoader(pathArrayForTiffLoader);
    case VolumeFileFormat.DATA:
      if (!options?.rawArrayOptions) {
        throw new Error("Must provide RawArrayOptions for RawArrayLoader");
      }
      return new RawArrayLoader(options?.rawArrayOptions.data, options?.rawArrayOptions.metadata);
  }
}
