import { ARRAY_CONSTRUCTORS, type NumberType, type TypedArray } from "../types.js";

export type CopyChunkParams = {
  /** Dimensions of the source array, in majority-increasing order. */
  srcShape: number[];
  /** Dimensions of the destination array, in majority-increasing order. */
  destShape: number[];
  /** Offset at which to copy the source chunk in the destination array per dimension. */
  offset: number[];
  /** Order of dimensions in the destination array, assuming source dimension order is `[1, 2, 3, ... ]`. */
  dimensionOrder?: number[];
};

export class ChunkIndexError extends Error {
  constructor(message: string) {
    super("ChunkIndexError: " + message);
  }
}

const last = <T>(arr: T[]): T => arr[arr.length - 1];

const validateCopyChunkParams = ({ srcShape, destShape, offset, dimensionOrder }: CopyChunkParams): void => {
  const srcRank = srcShape.length;
  const destRank = destShape.length;
  if (destRank !== srcRank) {
    throw new ChunkIndexError(`destination array rank (${destRank}) does not match source chunk rank (${srcRank})`);
  }
  if (offset.length !== srcRank) {
    throw new ChunkIndexError(`offset rank ${offset.length} does not match source chunk rank ${srcRank}`);
  }
  if (dimensionOrder !== undefined && dimensionOrder.length !== srcRank) {
    const { length } = dimensionOrder;
    throw new ChunkIndexError(`dimension order rank (${length}) does not match source chunk rank (${srcRank})`);
  }
  destShape.forEach((destDim, idx) => {
    const srcDim = srcShape[idx];
    const offsetI = offset[idx];
    if (srcDim + offsetI > destDim) {
      throw new ChunkIndexError(
        `dimension ${idx} out of bounds (destination length ${destDim} vs. source length ${srcDim} + offset ${offsetI})`
      );
    }
  });
};

const shapeToStrides = (shape: number[], length: number): number[] => {
  const strides = shape.reduceRight<number[]>((strides, dim) => [dim * strides[0], ...strides], [1]);
  const expectedLength = strides.shift();
  if (expectedLength !== length) {
    throw new ChunkIndexError(`buffer length does not match dimensions (expected ${expectedLength}, found ${length})`);
  }
  return strides;
};

function* indexes(start: number[], step: number[], count: number[]) {
  if (count.some((value) => value < 1)) {
    return;
  }

  const counters = Array(step.length).fill(0);
  const sums = [...start];
  const lastIndex = sums.length - 1;
  let i = 0;

  while (true) {
    while (i < lastIndex) {
      const prevSum = sums[i];
      i += 1;
      sums[i] += prevSum;
    }

    yield sums[lastIndex];

    while (true) {
      counters[i] += 1;
      sums[i] += step[i];

      if (counters[i] < count[i]) {
        break;
      }

      counters[i] = 0;
      sums[i] = start[i];
      i -= 1;

      if (i < 0) {
        return;
      }
    }
  }
}

/**
 * Copies an n-dimensional chunk into an n-dimensional destination array of equal or larger size.
 *
 * Handles placing the chunk at arbitrary offsets in the larger array (if )
 */
export const copyChunk = (src: TypedArray, dest: TypedArray, params: CopyChunkParams): void => {
  validateCopyChunkParams(params);

  const srcStrides = shapeToStrides(params.srcShape, src.length);
  let destStrides = shapeToStrides(params.destShape, dest.length);
  let destStart = destStrides.map((stride, i) => stride * params.offset[i]);
  let counts = [...params.srcShape];

  // Resolve dimension order
  if (params.dimensionOrder) {
    if ([...params.dimensionOrder].sort().some((val, idx) => val !== idx)) {
      throw new ChunkIndexError(`invalid dimension order: missing or duplicated dimensions (${params.dimensionOrder})`);
    }
    destStart = params.dimensionOrder.map((i) => destStart[i]);
    destStrides = params.dimensionOrder.map((i) => destStrides[i]);
    counts = params.dimensionOrder.map((i) => counts[i]);
  }

  // Remove dims where `src` covers the whole domain in `dest`, so they get copied in one contiguous `set` call
  let lastStart = 0;
  while (last(srcStrides) === last(destStrides) && lastStart === 0) {
    srcStrides.pop();
    destStrides.pop();
    counts.pop();
    lastStart = destStart.pop()!;

    if (srcStrides.length === 0 || destStrides.length === 0) {
      // We can just copy the whole thing in one shot!
      dest.set(src, lastStart);
      return;
    }

    destStart[destStart.length - 1] += lastStart;
  }

  const srcStride = last(srcStrides);
  let srcStart = 0;
  let srcEnd = srcStride;
  for (const destIndex of indexes(destStart, destStrides, counts)) {
    const slice = src.subarray(srcStart, srcEnd);
    dest.set(slice, destIndex);
    srcStart = srcEnd;
    srcEnd += srcStride;
  }
};

/**
 * Special case of `copyChunk`: reorders the dimensions of a chunk in buffer `src` with shape `shape` and data type
 * `dtype` into a new buffer according to `order`.
 */
export const reorderChunk = (src: TypedArray, shape: number[], order: number[], dtype: NumberType): TypedArray => {
  const dest = new ARRAY_CONSTRUCTORS[dtype](src.length);
  const params = {
    srcShape: shape,
    destShape: shape,
    dimensionOrder: order,
    offset: Array(shape.length).fill(0),
  };
  copyChunk(src, dest, params);
  return dest;
};
