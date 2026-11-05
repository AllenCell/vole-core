import * as indexingTasks from "./indexing_task.js";
import * as zarrTasks from "./sources/ome_zarr/zarr_codec_worker.js";
import { initWorker as _initWorker, BorrowGuard, taskHandle, type Task } from "./task_pool/index.js";

export const copyChunkTask = taskHandle<typeof indexingTasks.copyChunkTask>("copyChunk", (src) => {
  return BorrowGuard.isBorrowGuard(src) ? [] : [src.buffer];
});
export const reorderChunkTask = taskHandle<typeof indexingTasks.reorderChunkTask>("reorderChunk", (src) => {
  return BorrowGuard.isBorrowGuard(src) ? [] : [src.buffer];
});

export const initWorker = (tasks?: Task[]): void => {
  _initWorker([
    zarrTasks.encodeTask,
    zarrTasks.decodeTask,
    indexingTasks.copyChunkTask,
    indexingTasks.reorderChunkTask,
    ...(tasks ?? []),
  ]);
};
