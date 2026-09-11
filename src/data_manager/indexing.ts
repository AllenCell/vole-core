import type { TypedArray, NumberType } from "../types.js";

export type SetChunkParams = {
  srcShape: number[];
  destShape: number[];
  offset: number[];
};

const headTail = <T>(list: T[]): [T, T[]] => [list[0], list.splice(1)];
const last = <T>(list: T[]): T => list[list.length - 1];
const empty = <T>(list: T[]): list is [] => list.length === 0;

/** Combines dimensions that can be copied in a single `set` */
export const consolidateParams = (params: SetChunkParams): SetChunkParams => {
  const srcShape = [...params.srcShape];
  const destShape = [...params.destShape];
  const offset = [...params.offset];
  while (
    !empty(offset) &&
    !empty(srcShape) &&
    !empty(destShape) &&
    last(offset) === 0 &&
    last(srcShape) === last(destShape)
  ) {
    offset.pop();
    destShape.pop();
    const shape = srcShape.pop()!;
    srcShape[srcShape.length - 1] *= shape;
    destShape[destShape.length - 1] *= shape;
  }
  return { srcShape, destShape, offset };
};

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
  dest: TypedArray<T>,
  srcStrides: number[],
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
  const { srcShape, destShape, offset } = consolidateParams(params);
  const srcStrides = shapeToStrides(srcShape, src.length);
  const destStrides = shapeToStrides(destShape, dest.length);
  set(src, dest, srcStrides, destStrides, offset);
};
