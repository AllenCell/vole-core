import type { TypedArray, NumberType } from "../types.js";

export type SetChunkParams = {
  srcShape: number[];
  destShape: number[];
  offset: number[];
};

const splitHead = <T>(list: T[]): [T, T[]] => [list[0], list.splice(1)];
const splitLast = <T>(list: T[]): [T[], T] => [list.splice(0, list.length - 1), list[list.length - 1]];

/** Combines dimensions that can be copied in a single `set` */
export const consolidateContiguous = (params: SetChunkParams): SetChunkParams => {
  let { srcShape, destShape, offset } = params;

  while (true) {
    const [srcRest, srcLast] = splitLast(srcShape);
    const [destRest, destLast] = splitLast(destShape);
    const [offsetRest, offsetLast] = splitLast(offset);

    if (srcRest.length < 1 || destRest.length < 1 || srcLast !== destLast || offsetLast !== 0) {
      break;
    }

    srcShape = srcRest;
    destShape = destRest;
    offset = offsetRest;
    srcShape[srcShape.length - 1] *= srcLast;
    destShape[destShape.length - 1] *= srcLast;
    offset[offset.length - 1] *= srcLast;
  }

  return { srcShape, destShape, offset };
};

const shapeToStrides = (shape: number[], length: number): number[] => {
  const strides = shape.reduceRight((strides, dim) => [dim * (strides[0] ?? 1), ...strides], [] as number[]);
  const [expectedLength, result] = splitHead(strides);
  if (expectedLength !== length) {
    throw new Error(
      `n-dimensional array length does not match dimensions (expected ${expectedLength}, found ${length})`
    );
  }
  return result;
};

const set = <T extends NumberType = NumberType>(
  src: TypedArray<T>,
  dest: TypedArray<T>,
  srcStrides: number[],
  destStrides: number[],
  offsets: number[]
) => {
  if (srcStrides.length === 0) {
    dest.set(src, offsets[0]);
    return;
  }

  const [srcStride, srcStridesRest] = splitHead(srcStrides);
  const [destStride, destStridesRest] = splitHead(destStrides);
  const [offset, offsetsRest] = splitHead(offsets);
  let srcStart = 0;
  let destStart = destStride * offset;
  let srcEnd: number, destEnd: number;

  while (srcStart < src.length) {
    srcEnd = srcStart + srcStride;
    destEnd = destStart + destStride;
    const srcSlice = src.subarray(srcStart, srcEnd);
    const destSlice = dest.subarray(destStart, destEnd);
    set(srcSlice, destSlice, srcStridesRest, destStridesRest, offsetsRest);
    srcStart = srcEnd;
    destStart = destEnd;
  }
};

export const setFromChunk = <T extends NumberType = NumberType>(
  src: TypedArray<T>,
  dest: TypedArray<T>,
  params: SetChunkParams
) => {
  const { srcShape, destShape, offset } = consolidateContiguous(params);
  const srcStrides = shapeToStrides(srcShape, src.length);
  const destStrides = shapeToStrides(destShape, dest.length);
  set(src, dest, srcStrides, destStrides, offset);
};
