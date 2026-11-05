import { ARRAY_CONSTRUCTORS, type NumberType, type TypedArray } from "../types.js";

export type CopyChunkParams = {
  /** Dimensions of the source array. */
  srcShape: number[];
  /** Dimensions of the destination array. */
  destShape: number[];
  /**
   * Size of the region of the source chunk to copy into the destination array. Regions always start at
   * `[0, 0, 0, ...]`. Must be smaller than `srcShape` in every dimensinon.
   */
  copySize: number[];
  /** Offset to copy the source chunk to in the destination array per dimension. */
  offset: number[];
  /** Order of dimensions in the destination array, assuming source dimension order is `[0, 1, 2, ... ]`. */
  dimensionOrder?: number[];
};

export class ChunkIndexError extends Error {
  constructor(message: string) {
    super("ChunkIndexError: " + message);
  }
}

const last = <T>(arr: T[]): T => arr[arr.length - 1];

const validateCopyChunkParams = ({ srcShape, destShape, copySize, offset, dimensionOrder }: CopyChunkParams): void => {
  const srcDims = srcShape.length;
  const destDims = destShape.length;
  if (destDims !== srcDims) {
    throw new ChunkIndexError(
      `destination array dimensionality (${destDims}) does not match source chunk dimensionality (${srcDims})`
    );
  }
  if (offset.length !== srcDims) {
    throw new ChunkIndexError(
      `offset dimensionality ${offset.length} does not match source chunk dimensionality ${srcDims}`
    );
  }
  if (copySize.length !== srcDims) {
    throw new ChunkIndexError(
      `copy size dimensionality ${copySize.length} does not match source chunk dimensionality ${srcDims}`
    );
  }
  if (dimensionOrder !== undefined && dimensionOrder.length !== srcDims) {
    const { length } = dimensionOrder;
    throw new ChunkIndexError(
      `dimension order dimensionality (${length}) does not match source chunk dimensionality (${srcDims})`
    );
  }
  srcShape.forEach((srcDim, idx) => {
    const size = copySize[idx];
    if (size > srcDim) {
      throw new ChunkIndexError(`copy size is larger than source chunk in dimension ${idx} (${size} vs ${srcDim})`);
    }
  });
  destShape.forEach((destDim, idx) => {
    const size = copySize[idx];
    const offsetI = offset[idx];
    if (size + offsetI > destDim) {
      throw new ChunkIndexError(
        `dimension ${idx} out of bounds (destination length ${destDim} vs. copy size ${size} + offset ${offsetI})`
      );
    }
  });
};

const shapeToStrides = (shape: number[], length: number, name: string): number[] => {
  const strides = shape.reduceRight<number[]>((strides, dim) => [dim * strides[0], ...strides], [1]);
  const expectedLength = strides.shift();
  if (expectedLength !== length) {
    throw new ChunkIndexError(
      `${name} buffer length does not match dimensions (expected ${expectedLength}, found ${length})`
    );
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
 * Handles placing the chunk at arbitrary n-dimensional offsets in the larger array, and reordering dimensions.
 */
export const copyChunk = (src: TypedArray, dest: TypedArray, params: CopyChunkParams): void => {
  validateCopyChunkParams(params);

  const srcStrides = shapeToStrides(params.srcShape, src.length, "source");
  let destStrides = shapeToStrides(params.destShape, dest.length, "destination");
  let destStart = destStrides.map((stride, i) => stride * params.offset[i]);
  let counts = [...params.copySize];

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
  // (only possible while the copied region spans the whole source dimension, so the source stays contiguous)
  while (
    srcStrides.length > 0 &&
    last(srcStrides) === last(destStrides) &&
    lastStart === 0 &&
    params.copySize[srcStrides.length - 1] === params.srcShape[srcStrides.length - 1]
  ) {
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
  const srcIndexes = indexes(Array(srcStrides.length).fill(0), srcStrides, counts);
  for (const destIndex of indexes(destStart, destStrides, counts)) {
    const srcStart = srcIndexes.next().value as number;
    dest.set(src.subarray(srcStart, srcStart + srcStride), destIndex);
  }
};

/**
 * Special case of `copyChunk`: copies a chunk with shape `shape` and type `dtype` from `src` into a new buffer
 * of equal length, with dimension order `order`.
 */
export const reorderChunk = (src: TypedArray, shape: number[], order: number[], dtype: NumberType): TypedArray => {
  const dest = new ARRAY_CONSTRUCTORS[dtype](src.length);
  const params = {
    srcShape: shape,
    destShape: shape,
    copySize: shape,
    dimensionOrder: order,
    offset: Array(shape.length).fill(0),
  };
  copyChunk(src, dest, params);
  return dest;
};
