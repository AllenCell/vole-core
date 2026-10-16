import * as zarr from "zarrita";

import { taskHandle, TaskPool } from "../../task_pool/index.js";
import type { encodeTask as encodeTaskType, decodeTask as decodeTaskType } from "./zarr_codec_worker.js";

let codecCounter = 0;

const encodeTask = taskHandle<typeof encodeTaskType>("zarrEncode", (data) => [data.buffer]);
const decodeTask = taskHandle<typeof decodeTaskType>("zarrDecode", (data) => [data.buffer]);

export const augmentCodec = (name: string, pool: TaskPool) => {
  const codec = zarr.registry.get(name);
  if (codec === undefined) {
    console.warn(`No such codec: ${name}`);
    return;
  }

  zarr.registry.set(name, async () => ({
    fromConfig: (config, meta) => {
      const descriptor = { config, meta, name, id: codecCounter };
      codecCounter++;

      return {
        encode: (data: Uint8Array) => pool.runTask(encodeTask, data, descriptor),
        decode: (data: Uint8Array) => pool.runTask(decodeTask, data, descriptor),
      };
    },
  }));
};
