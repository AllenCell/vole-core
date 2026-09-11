import type { TypedArray, NumberType } from "../types.js";

const headTail = <T>(list: T[]): [T, T[]] => [list[0], list.splice(1)];

export const setFromChunk = <T extends NumberType = NumberType>(
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
    setFromChunk(srcSlice, srcStridesRest, destSlice, destStridesRest, offsetsRest);
    srcStart = srcEnd;
    destStart = destEnd;
  }
};
