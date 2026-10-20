import { copyChunkTask, reorderChunkTask } from "../src/data_manager/indexing_task.js";
import { decodeTask, encodeTask } from "../src/data_manager/sources/ome_zarr/zarr_codec_worker.js";
import { initWorker } from "../src/data_manager/task_pool/runner.js";

initWorker([encodeTask, decodeTask, copyChunkTask, reorderChunkTask]);
