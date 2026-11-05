import type { NumberType, TypedArray } from "../types.js";
import { copyChunk, reorderChunk, type CopyChunkParams } from "./indexing.js";
import { type BorrowedArray, task } from "./task_pool/index.js";

export const copyChunkTask = task(
  "copyChunk",
  (src: TypedArray | BorrowedArray, dest: BorrowedArray, params: CopyChunkParams) => {
    copyChunk(src, dest, params);
    return { result: undefined, transfer: [] };
  }
);

export const reorderChunkTask = task(
  "reorderChunk",
  (src: TypedArray | BorrowedArray, shape: number[], order: number[], dtype: NumberType) => {
    const result = reorderChunk(src, shape, order, dtype);
    return { result, transfer: [result.buffer] };
  }
);
