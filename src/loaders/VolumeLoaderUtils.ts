import { Box3, Vector2, Vector3 } from "three";

import { CImageInfo, type ImageInfo } from "../ImageInfo.js";
import { LoadSpec } from "./IVolumeLoader.js";

export const MAX_ATLAS_EDGE = 4096;

// Map from units to their symbols
const UNIT_SYMBOLS = {
  angstrom: "Å",
  day: "d",
  foot: "ft",
  hour: "h",
  inch: "in",
  meter: "m",
  micron: "μm",
  mile: "mi",
  minute: "min",
  parsec: "pc",
  second: "s",
  yard: "yd",
};

// Units which may take SI prefixes (e.g. micro-, tera-)
const SI_UNITS: (keyof typeof UNIT_SYMBOLS)[] = ["meter", "second"];

// SI prefixes which abbreviate in nonstandard ways
const SI_PREFIX_ABBVS = {
  micro: "μ",
  deca: "da",
};

/** Converts a full spatial or temporal unit name supported by OME-Zarr to its unit symbol */
// (see https://ngff.openmicroscopy.org/latest/#axes-md)
export function unitNameToSymbol(unitName?: string): string | null {
  if (unitName === undefined) {
    return null;
  }

  if (UNIT_SYMBOLS[unitName]) {
    return UNIT_SYMBOLS[unitName];
  }

  const prefixedSIUnit = SI_UNITS.find((siUnit) => unitName.endsWith(siUnit));
  if (prefixedSIUnit) {
    const prefix = unitName.substring(0, unitName.length - prefixedSIUnit.length);

    if (SI_PREFIX_ABBVS[prefix]) {
      // "special" SI prefix
      return SI_PREFIX_ABBVS[prefix] + UNIT_SYMBOLS[prefixedSIUnit];
    }

    // almost all SI prefixes are abbreviated by first letter, capitalized if prefix ends with "a"
    const capitalize = prefix.endsWith("a");
    const prefixAbbr = capitalize ? prefix[0].toUpperCase() : prefix[0];
    return prefixAbbr + UNIT_SYMBOLS[prefixedSIUnit];
  }

  return null;
}

// We want to find the most "square" packing of z tw by th tiles.
// Compute number of rows and columns.
export function computePackedAtlasDims(z: number, tw: number, th: number): Vector2 {
  let nextrows = 1;
  let nextcols = z;
  let ratio = (nextcols * tw) / (nextrows * th);
  let nrows = nextrows;
  let ncols = nextcols;
  while (ratio > 1) {
    nrows = nextrows;
    ncols = nextcols;
    nextcols -= 1;
    nextrows = Math.ceil(z / nextcols);
    ratio = (nextcols * tw) / (nextrows * th);
  }
  return new Vector2(nrows, ncols);
}

function doesSpatialDimensionFitInAtlas(
  spatialDimZYX: [number, number, number],
  maxAtlasEdge = MAX_ATLAS_EDGE
): boolean {
  // Estimate atlas size
  const x = spatialDimZYX[2];
  const y = spatialDimZYX[1];
  const z = spatialDimZYX[0];
  const xtiles = Math.floor(maxAtlasEdge / x);
  const ytiles = Math.floor(maxAtlasEdge / y);
  return xtiles * ytiles >= z;
}

/** Picks the largest scale level that can fit into a texture atlas with edges no longer than `maxAtlasEdge`. */
export function estimateLevelForAtlas(
  spatialDimsZYX: [number, number, number][],
  maxAtlasEdge = MAX_ATLAS_EDGE
): number | undefined {
  if (spatialDimsZYX.length <= 1) {
    return 0;
  }

  for (let i = 0; i < spatialDimsZYX.length; ++i) {
    // estimate atlas size:
    if (doesSpatialDimensionFitInAtlas(spatialDimsZYX[i], maxAtlasEdge)) {
      return i;
    }
  }
  return undefined;
}

type ZYX = [number, number, number];
const maxCeil = (val: number): number => Math.max(Math.ceil(val), 1);
const scaleDims = (size: Vector3, [z, y, x]: ZYX): ZYX => [
  maxCeil(z * size.z),
  maxCeil(y * size.y),
  maxCeil(x * size.x),
];

export function scaleDimsToSubregion(subregion: Box3, dims: ZYX): ZYX {
  const size = subregion.getSize(new Vector3());
  return scaleDims(size, dims);
}

export function scaleMultipleDimsToSubregion(subregion: Box3, dims: ZYX[]): ZYX[] {
  const size = subregion.getSize(new Vector3());
  return dims.map((dim) => scaleDims(size, dim));
}

/**
 * Picks the best scale level to load based on scale level dimensions and a `LoadSpec`. This calls
 * `estimateLevelForAtlas`, then accounts for `LoadSpec`'s scale level picking properties:
 * - `multiscaleLevel` imposes a minimum scale level (or *maximum* resolution level) to load
 * - `maxAtlasEdge` sets the maximum size of the texture atlas that may be produced by a load
 * - `scaleLevelBias` offsets the scale level index after the optimal level is picked based on `maxAtlasEdge`
 *
 *  This function assumes that `spatialDimsZYX` has already been appropriately scaled to match `loadSpec`'s `subregion`.
 */
export function pickLevelToLoadUnscaled(loadSpec: LoadSpec, spatialDimsZYX: ZYX[]): number {
  if (loadSpec.useExplicitLevel && loadSpec.multiscaleLevel !== undefined) {
    // clamp to actual allowed level range
    return Math.max(0, Math.min(spatialDimsZYX.length - 1, loadSpec.multiscaleLevel));
  }

  let levelToLoad = estimateLevelForAtlas(spatialDimsZYX, loadSpec.maxAtlasEdge);
  // Check here for whether levelToLoad is within max atlas size?
  if (levelToLoad !== undefined) {
    levelToLoad = Math.max(levelToLoad + (loadSpec.scaleLevelBias ?? 0), loadSpec.multiscaleLevel ?? 0);
    levelToLoad = Math.max(0, Math.min(spatialDimsZYX.length - 1, levelToLoad));

    if (doesSpatialDimensionFitInAtlas(spatialDimsZYX[levelToLoad], loadSpec.maxAtlasEdge)) {
      return levelToLoad;
    }
  }

  // Level to load could not be loaded due to atlas size constraints.
  if (levelToLoad === undefined) {
    // No optimal level exists so choose the smallest level to report out
    levelToLoad = spatialDimsZYX.length - 1;
  }
  const smallestDims = spatialDimsZYX[levelToLoad];
  console.error(
    `Volume is too large; no multiscale level found that fits in preferred memory footprint. Selected level ${levelToLoad}  has dimensions `,
    smallestDims,
    `. Max atlas edge allowed is ${loadSpec.maxAtlasEdge}.`
  );
  console.log("All available levels: ", spatialDimsZYX);

  return levelToLoad;
}

/**
 * Picks the best scale level to load based on scale level dimensions and a `LoadSpec`. This calls
 * `estimateLevelForAtlas` and accounts for all properties of `LoadSpec` considered by
 * `pickLevelToLoadUnscaled`, and additionally scales the dimensions of the scale levels to account for the
 * `LoadSpec`'s `subregion` property.
 */
export function pickLevelToLoad(loadSpec: LoadSpec, spatialDimsZYX: ZYX[]): number {
  const scaledDims = scaleMultipleDimsToSubregion(loadSpec.subregion, spatialDimsZYX);
  return pickLevelToLoadUnscaled(loadSpec, scaledDims);
}

/** Given the size of a volume in pixels, convert a `Box3` in the 0-1 range to pixels */
export function convertSubregionToPixels(region: Box3, size: Vector3): Box3 {
  const min = region.min.clone().multiply(size).floor();
  const max = region.max.clone().multiply(size).ceil();

  // ensure it's always valid to specify the same number at both ends and get a single slice
  if (min.x === max.x && min.x < size.x) {
    max.x += 1;
  }
  if (min.y === max.y && min.y < size.y) {
    max.y += 1;
  }
  if (min.z === max.z && min.z < size.z) {
    max.z += 1;
  }

  return new Box3(min, max);
}

/**
 * Return the subset of `container` specified by `region`, assuming that `region` contains fractional values (between 0
 * and 1). i.e. if `container`'s range on the X axis is 0-4 and `region`'s is 0.25-0.5, the result will have range 1-2.
 */
export function composeSubregion(region: Box3, container: Box3): Box3 {
  const size = container.getSize(new Vector3());
  const min = region.min.clone().multiply(size).add(container.min);
  const max = region.max.clone().multiply(size).add(container.min);
  return new Box3(min, max);
}

function isEmpty(obj: object) {
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      return false;
    }
  }
  return true;
}

// currently everything needed can come from the imageInfo
// but in the future each IVolumeLoader could have a completely separate implementation.
export function createDefaultMetadata(rawImageInfo: ImageInfo): Record<string, unknown> {
  // wrap
  const imageInfo = new CImageInfo(rawImageInfo);
  const physicalSize = imageInfo.volumeSize.clone().multiply(imageInfo.physicalPixelSize);
  const metadata = {};
  metadata["Dimensions"] = { ...imageInfo.subregionSize };
  metadata["Original dimensions"] = { ...imageInfo.originalSize };
  metadata["Physical size"] = {
    x: physicalSize.x + imageInfo.spatialUnit,
    y: physicalSize.y + imageInfo.spatialUnit,
    z: physicalSize.z + imageInfo.spatialUnit,
  };
  metadata["Physical size per pixel"] = {
    x: imageInfo.physicalPixelSize.x + imageInfo.spatialUnit,
    y: imageInfo.physicalPixelSize.y + imageInfo.spatialUnit,
    z: imageInfo.physicalPixelSize.z + imageInfo.spatialUnit,
  };
  metadata["Multiresolution levels"] = rawImageInfo.multiscaleLevelDims;
  // TODO decide???? combined or not?
  const totalChannels = imageInfo.numChannelsPerSource.reduce((a, b) => a + b, 0);
  metadata["Channels"] = totalChannels;
  metadata["Time series frames"] = imageInfo.times || 1;
  // don't add User data if it's empty
  if (rawImageInfo.userData && !isEmpty(rawImageInfo.userData)) {
    metadata["User data"] = rawImageInfo.userData;
  }
  return metadata;
}
