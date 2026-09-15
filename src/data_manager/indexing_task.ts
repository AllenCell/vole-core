import type { NumberType, TypedArray } from "../types.js";
import { copyChunk, reorderChunk, type CopyChunkParams } from "./indexing.js";
import { registerTask, task } from "./task_pool/registry.js";
import type { BorrowedArray } from "./task_pool/task.js";

const copyChunkTask = task(
  "copyChunk",
  (src: TypedArray | BorrowedArray, dest: BorrowedArray, params: CopyChunkParams) => {
    copyChunk(src, dest, params);
    return { result: undefined, transfer: [] };
  }
);

const reorderChunkTask = task(
  "reorderChunk",
  (src: TypedArray | BorrowedArray, shape: number[], order: number[], dtype: NumberType) => {
    const result = reorderChunk(src, shape, order, dtype);
    return { result, transfer: [result.buffer] };
  }
);

registerTask(copyChunkTask);
registerTask(reorderChunkTask);

export type CopyChunkTask = typeof copyChunkTask;
export type ReorderChunkTask = typeof reorderChunkTask;
