import type { TypedArray, NumberType } from "../types.js";

const headTail = <T>(list: T[]): [T, T[]] => [list[0], list.splice(1)];

const shapeToStrides = (shape: number[], length: number): number[] => {
  const strides = shape.reduceRight((strides, dim) => [dim * (strides[0] ?? 1), ...strides], [] as number[]);
  const [expectedLength, result] = headTail(strides);
  if (expectedLength !== length) {
    throw new Error(
      `n-dimensional array length does not match dimensions (expected ${expectedLength}, found ${length})`
    );
  }
  return result;
};

const set = <T extends NumberType = NumberType>(
  src: TypedArray<T>,
  srcStrides: number[],
  dest: TypedArray<T>,
  destStrides: number[],
  offsets: number[]
) => {
  if (srcStrides.length === 0) {
    dest.set(src, offsets[0]);
    return;
  }

  const [srcStride, srcStridesRest] = headTail(srcStrides);
  const [destStride, destStridesRest] = headTail(destStrides);
  const [offset, offsetsRest] = headTail(offsets);
  let srcStart = 0;
  let destStart = destStride * offset;
  let srcEnd: number, destEnd: number;

  while (srcStart < src.length) {
    srcEnd = srcStart + srcStride;
    destEnd = destStart + destStride;
    const srcSlice = src.subarray(srcStart, srcEnd);
    const destSlice = dest.subarray(destStart, destEnd);
    set(srcSlice, srcStridesRest, destSlice, destStridesRest, offsetsRest);
    srcStart = srcEnd;
    destStart = destEnd;
  }
};

export const setFromChunk = <T extends NumberType = NumberType>(
  src: TypedArray<T>,
  srcShape: number[],
  dest: TypedArray<T>,
  destShape: number[],
  offset: number[]
) => {
  const srcStrides = shapeToStrides(srcShape, src.length);
  const destStrides = shapeToStrides(destShape, dest.length);
  set(src, srcStrides, dest, destStrides, offset);
};
