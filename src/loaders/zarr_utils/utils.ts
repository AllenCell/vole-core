import { VolumeLoadErrorType, VolumeLoadError } from "../VolumeLoadError.js";
import type {
  NumericZarrArray,
  OMEAxis,
  OMECoordinateTransformation,
  OMEDataset,
  OMEMultiscale,
  TCZYX,
  ZarrSource,
} from "./types.js";

/**
 * Attempts to parse `color` as a 24-bit (6-digit) hexadecimal color with a possible leading `#`.
 *
 * Six-digit hex is the only allowable color representation in the OMERO metadata spec.
 */
export function parseHexColor(color: string | undefined): [number, number, number] | undefined {
  if (color === undefined) {
    return undefined;
  }

  const result = /^#?([a-fA-F\d]{2})([a-fA-F\d]{2})([a-fA-F\d]{2})$/i.exec(color);
  if (result) {
    return [parseInt(result[1], 16), parseInt(result[2], 16), parseInt(result[3], 16)];
  } else {
    return undefined;
  }
}

/** Extracts channel names from a `ZarrSource`. Handles missing `omeroMetadata`. Does *not* resolve name collisions. */
export function getSourceChannelMeta(src: ZarrSource): {
  names: string[];
  colors: ([number, number, number] | undefined)[];
} {
  if (src.omeroMetadata?.channels) {
    const { channels } = src.omeroMetadata;
    const names: string[] = [];
    const colors: ([number, number, number] | undefined)[] = [];

    for (let i = 0; i < channels.length; i++) {
      const channel = channels[i];
      names.push(channel.label ?? `Channel ${i + src.channelOffset}`);
      colors.push(parseHexColor(channel.color));
    }

    return { names, colors };
  }

  const cIdx = src.axesTCZYX[1];
  const length = cIdx < 0 ? 1 : src.scaleLevels[0].shape[cIdx];
  const names = Array.from({ length }, (_, idx) => `Channel ${idx + src.channelOffset}`);
  const colors = Array.from({ length }, () => undefined);
  return { names, colors };
}

/** Turns `axesTCZYX` into the number of dimensions in the array */
export const getDimensionCount = ([t, c, z]: TCZYX<number>) => 2 + Number(t > -1) + Number(c > -1) + Number(z > -1);

export function remapAxesToTCZYX(axes: OMEAxis[]): TCZYX<number> {
  const axesTCZYX: TCZYX<number> = [-1, -1, -1, -1, -1];
  const axisNames = ["t", "c", "z", "y", "x"];

  axes.forEach((axis, idx) => {
    const axisIdx = axisNames.indexOf(axis.name);
    if (axisIdx > -1) {
      axesTCZYX[axisIdx] = idx;
    } else {
      throw new VolumeLoadError(`Unrecognized axis in zarr: ${axis.name}`, {
        type: VolumeLoadErrorType.INVALID_METADATA,
      });
    }
  });

  // it is possible that Z might not exist but we require X and Y at least.
  const noXAxis = axesTCZYX[4] === -1;
  if (noXAxis || axesTCZYX[3] === -1) {
    throw new VolumeLoadError(`Did not find ${noXAxis ? "an X" : "a Y"} axis in zarr`, {
      type: VolumeLoadErrorType.INVALID_METADATA,
    });
  }

  return axesTCZYX;
}

/**
 * Reorder an array of `values` in TCZYX order to the dimension order specified by `orderTCZYX`.
 *
 * Each element of `orderTCZYX` is the index of each dimension in its volume's native dimension
 * order, or `-1` if the volume does not contain that dimension. For example, the array
 * `[-1, 1, 0, 2, 3]` represents ZCYX order: T not present; C at index `1`; Z at index `0`; Y at
 * index `2`; X at index `3`.
 */
export function orderByDimension<T>(values: TCZYX<T>, orderTCZYX: TCZYX<number>): T[] {
  const specLen = getDimensionCount(orderTCZYX);
  const result: T[] = Array(specLen);

  orderTCZYX.forEach((dimIndex, tczyxIndex) => {
    if (dimIndex >= 0) {
      if (dimIndex >= specLen) {
        throw new VolumeLoadError(`Unexpected axis index in zarr: ${dimIndex}`, {
          type: VolumeLoadErrorType.INVALID_METADATA,
        });
      }
      result[dimIndex] = values[tczyxIndex];
    }
  });

  return result;
}

/** Reorder an array of values in the given dimension order to [T, C, Z, Y, X] */
export function orderByTCZYX<T>(valsDimension: T[], orderTCZYX: TCZYX<number>, defaultValue: T): TCZYX<T> {
  const result: TCZYX<T> = [defaultValue, defaultValue, defaultValue, defaultValue, defaultValue];

  orderTCZYX.forEach((val, idx) => {
    if (val >= 0) {
      if (val >= valsDimension.length) {
        throw new VolumeLoadError(`Unexpected axis index in zarr: ${val}`, {
          type: VolumeLoadErrorType.INVALID_METADATA,
        });
      }
      result[idx] = valsDimension[val];
    }
  });

  return result;
}

/** Select the scale transform from an OME metadata object with coordinate transforms, and return it in TCZYX order */
export function getScale(dataset: OMEDataset | OMEMultiscale, orderTCZYX: TCZYX<number>): TCZYX<number> {
  const transforms = dataset.coordinateTransformations;

  if (transforms === undefined) {
    console.warn("WARNING: OMEZarrLoader: no coordinate transformations for scale level.");
    return [1, 1, 1, 1, 1];
  }

  // this assumes we'll never encounter the "path" variant
  const isScaleTransform = (t: OMECoordinateTransformation): t is { type: "scale"; scale: number[] } =>
    t.type === "scale";

  // there can be any number of coordinateTransformations
  // but there must be only one of type "scale".
  const scaleTransform = transforms.find(isScaleTransform);
  if (!scaleTransform) {
    console.warn(`WARNING: OMEZarrLoader: no coordinate transformation of type "scale" for scale level.`);
    return [1, 1, 1, 1, 1];
  }

  const scale = scaleTransform.scale.slice();
  return orderByTCZYX(scale, orderTCZYX, 1);
}

/**
 * Defines a partial order of zarr arrays based on their size. Specifically:
 * - If array size x, y, z are all equal, the arrays are equal
 * - otherwise, if all xyz of `a` are less than or equal to those of `b`, `a` is less than `b` (and vice versa)
 * - if some xyz is less and some is greater, the arrays are uncomparable
 */
function compareZarrArraySize(
  aArr: NumericZarrArray,
  aTCZYX: TCZYX<number>,
  bArr: NumericZarrArray,
  bTCZYX: TCZYX<number>
): number | undefined {
  const aZ = aTCZYX[2] > -1 ? aArr.shape[aTCZYX[2]] : 1;
  const bZ = bTCZYX[2] > -1 ? bArr.shape[bTCZYX[2]] : 1;
  const diffZ = aZ - bZ;
  const diffY = aArr.shape[aTCZYX[3]] - bArr.shape[bTCZYX[3]];
  const diffX = aArr.shape[aTCZYX[4]] - bArr.shape[bTCZYX[4]];

  if (diffZ === 0 && diffY === 0 && diffX === 0) {
    return 0;
  } else if (diffZ <= 0 && diffY <= 0 && diffX <= 0) {
    return -1;
  } else if (diffZ >= 0 && diffY >= 0 && diffX >= 0) {
    return 1;
  } else {
    return undefined;
  }
}

const EPSILON = 0.00001;
const aboutEquals = (a: number, b: number): boolean => Math.abs(a - b) < EPSILON;

function scaleTransformsAreEqual(aSrc: ZarrSource, aLevel: number, bSrc: ZarrSource, bLevel: number): boolean {
  const aScale = getScale(aSrc.multiscaleMetadata.datasets[aLevel], aSrc.axesTCZYX);
  const bScale = getScale(bSrc.multiscaleMetadata.datasets[bLevel], bSrc.axesTCZYX);
  return aboutEquals(aScale[2], bScale[2]) && aboutEquals(aScale[3], bScale[3]) && aboutEquals(aScale[4], bScale[4]);
}

/**
 * Ensures that all scale levels in `sources` are matched up by size. More precisely: enforces that, for any scale
 * level `i`, the size of zarr array `s[i]` is equal for every source `s`. We accomplish this by removing any arrays
 * (and their associated OME dataset metadata) which don't match up in all sources.
 *
 * Note that this function modifies the input `sources` array rather than returning a new value.
 *
 * Assumes all sources have scale levels ordered by size from largest to smallest. (This should always be true for
 * compliant OME-Zarr data.)
 */
export function matchSourceScaleLevels(sources: ZarrSource[]): void {
  if (sources.length < 2) {
    return;
  }

  // Save matching scale levels and metadata here
  const matchedLevels: NumericZarrArray[][] = Array.from({ length: sources.length }, () => []);
  const matchedMetas: OMEDataset[][] = Array.from({ length: sources.length }, () => []);

  // Start as many index counters as we have sources
  const scaleIndexes: number[] = new Array(sources.length).fill(0);
  while (scaleIndexes.every((val, idx) => val < sources[idx].scaleLevels.length)) {
    // First pass: find the smallest source / determine if all sources are equal
    let allEqual = true;
    let smallestIdx = 0;
    let smallestSrc = sources[0];
    let smallestArr = smallestSrc.scaleLevels[scaleIndexes[0]];
    for (let currentIdx = 1; currentIdx < sources.length; currentIdx++) {
      const currentSrc = sources[currentIdx];
      const currentArr = currentSrc.scaleLevels[scaleIndexes[currentIdx]];

      const ordering = compareZarrArraySize(smallestArr, smallestSrc.axesTCZYX, currentArr, currentSrc.axesTCZYX);
      if (!ordering) {
        // Arrays are equal, or they are uncomparable
        if (ordering === undefined) {
          throw new VolumeLoadError("Incompatible zarr arrays: pixel dimensions are mismatched", {
            type: VolumeLoadErrorType.INVALID_MULTI_SOURCE_ZARR,
          });
        }

        // Now we know the arrays are equal, but they may still be invalid to match up because...
        // ...they have different scale transformations
        if (!scaleTransformsAreEqual(smallestSrc, scaleIndexes[smallestIdx], currentSrc, scaleIndexes[currentIdx])) {
          // today we are going to treat this as a warning.
          // For our implementation it is enough that the xyz pixel ranges are the same.
          // Ideally scale*arraysize=physical size is really the quantity that should be equal, for combining two volume data sets as channels.
          console.warn("Incompatible zarr arrays: scale levels of equal size have different scale transformations");
        }

        // ...they have different numbers of timesteps
        const largestT = smallestSrc.axesTCZYX[0] > -1 ? smallestArr.shape[smallestSrc.axesTCZYX[0]] : 1;
        const currentT = currentSrc.axesTCZYX[0] > -1 ? currentArr.shape[currentSrc.axesTCZYX[0]] : 1;
        if (largestT !== currentT) {
          // we also treat this as a warning.
          // In OmeZarrLoader we will take the minimum T size of all sources
          console.warn(`Incompatible zarr arrays: different numbers of timesteps: ${largestT} vs ${currentT}`);
        }
      } else {
        allEqual = false;
        if (ordering > 0) {
          smallestIdx = currentIdx;
          smallestSrc = currentSrc;
          smallestArr = currentArr;
        }
      }
    }

    if (allEqual) {
      // We've found a matching set of scale levels! Save it and increment all indexes
      for (let i = 0; i < scaleIndexes.length; i++) {
        const currentSrc = sources[i];
        const matchedScaleLevel = scaleIndexes[i];
        matchedLevels[i].push(currentSrc.scaleLevels[matchedScaleLevel]);
        matchedMetas[i].push(currentSrc.multiscaleMetadata.datasets[matchedScaleLevel]);
        scaleIndexes[i] += 1;
      }
    } else {
      // Increment the indexes of the sources which are larger than the smallest
      for (const [idx, srcIdx] of scaleIndexes.entries()) {
        const currentSrc = sources[idx];
        const currentArr = currentSrc.scaleLevels[srcIdx];
        const ordering = compareZarrArraySize(smallestArr, smallestSrc.axesTCZYX, currentArr, currentSrc.axesTCZYX);
        if (ordering !== 0) {
          scaleIndexes[idx] += 1;
        }
      }
    }
  }

  if (matchedLevels[0].length === 0) {
    throw new VolumeLoadError("Incompatible zarr arrays: no sets of scale levels found that matched in all sources", {
      type: VolumeLoadErrorType.INVALID_MULTI_SOURCE_ZARR,
    });
  }

  for (let i = 0; i < sources.length; i++) {
    sources[i].scaleLevels = matchedLevels[i];
    sources[i].multiscaleMetadata.datasets = matchedMetas[i];
  }
}
