import type { TypedArray } from "../types.js";

export type SetChunkParams = {
  srcShape: number[];
  destShape: number[];
  offset: number[];
  dimensionOrder?: number[];
};

interface SetDestination {
  set(array: ArrayLike<number>, offset?: number): void;
  length: number;
  innerLength?: number;
}

const shapeToStrides = (shape: number[], length: number, innerLength?: number): number[] => {
  const strides = shape.reduceRight<number[]>((strides, dim) => [dim * strides[0], ...strides], [1]);
  const expectedLength = strides.shift();
  if (expectedLength !== length) {
    throw new Error(
      `n-dimensional array length does not match dimensions (expected ${expectedLength}, found ${length})`
    );
  }
  if (innerLength !== undefined && strides.indexOf(innerLength) === -1) {
    throw new Error(`write a better error message (expected ${innerLength})`);
  }
  return strides;
};

function* indexes(start: number[], step: number[], count: number[]) {
  if (count.some((value) => value < 1)) {
    return;
  }

  const counters = Array(step.length).fill(0);
  const sums = [...start];
  let i = sums.length - 1;

  while (true) {
    while (i > 0) {
      const prevSum = sums[i];
      i -= 1;
      sums[i] += prevSum;
    }

    yield sums[0];

    while (true) {
      counters[i] += 1;
      sums[i] += step[i];

      if (counters[i] < count[i]) {
        break;
      }

      counters[i] = 0;
      sums[i] = start[i];
      i += 1;

      if (i >= step.length) {
        return;
      }
    }
  }
}

const last = <T>(arr: T[]): T => arr[arr.length - 1];

export const setFromChunk = (src: TypedArray, dest: SetDestination, params: SetChunkParams) => {
  const srcStrides = shapeToStrides(params.srcShape, src.length);
  let destStrides = shapeToStrides(params.destShape, dest.length, dest.innerLength);
  let destStart = destStrides.map((stride, i) => stride * params.offset[i]);
  let counts = [...params.srcShape];

  // Resolve dimension order
  if (params.dimensionOrder) {
    if ([...params.dimensionOrder].sort().some((val, idx) => val !== idx)) {
      throw new Error(`invalid dimension order: missing or duplicated dimensions (${params.dimensionOrder})`);
    }
    destStrides = params.dimensionOrder.map((i) => destStrides[i]);
    destStart = params.dimensionOrder.map((i) => destStart[i]);
    counts = params.dimensionOrder.map((i) => counts[i]);
  }

  // Even if the dimensions are contiguous, we can't `set` across `TypedArray` boundaries
  const maxStride = dest.innerLength ?? Infinity;
  let lastStart = 0;

  // Consolidate dims where `src` covers the whole domain in `dest`, so they get copied in one contiguous `set` call
  while (last(srcStrides) === last(destStrides) && lastStart === 0 && last(srcStrides) <= maxStride) {
    srcStrides.pop();
    destStrides.pop();
    counts.pop();
    lastStart = destStart.pop()!;

    if (srcStrides.length === 0 || destStrides.length === 0) {
      dest.set(src, lastStart);
      return;
    }

    destStart[destStart.length - 1] += lastStart;
  }

  const srcStride = last(srcStrides);
  let srcStart = 0;
  let srcEnd = srcStride;
  for (const destIndex of indexes(destStart.reverse(), destStrides.reverse(), counts.reverse())) {
    const slice = src.subarray(srcStart, srcEnd);
    dest.set(slice, destIndex);
    srcStart = srcEnd;
    srcEnd += srcStride;
  }
};
