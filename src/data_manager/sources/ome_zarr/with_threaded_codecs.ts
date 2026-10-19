import * as zarr from "zarrita";

import { taskHandle, TaskPool } from "../../task_pool/index.js";
import type { encodeTask as encodeTaskType, decodeTask as decodeTaskType } from "./zarr_codec_worker.js";

let codecCounter = 0;

type CodecKind = "array_to_array" | "array_to_bytes" | "bytes_to_bytes";

// MARK: Codec interface

const encodeTask = taskHandle<typeof encodeTaskType>("zarrEncode", (data) => [data.buffer]);
const decodeTask = taskHandle<typeof decodeTaskType>("zarrDecode", (data) => [data.buffer]);

type WorkerConfig = {
  pool: TaskPool;
  kind: CodecKind;
  codecs: zarr.CodecMetadata[];
};

zarr.registry.set("vole-worker", async () => ({
  fromConfig: (config, meta) => {
    const { pool, codecs, kind } = config as WorkerConfig;
    const descriptor = { codecs, meta, id: codecCounter };
    codecCounter++;

    return {
      encode: (data: Uint8Array) => pool.runTask(encodeTask, data, descriptor),
      decode: (data: Uint8Array) => pool.runTask(decodeTask, data, descriptor),
      kind,
    };
  },
}));

// MARK: Metadata parsing

const isMetaKey = (key: string): boolean =>
  key.endsWith(".zarray") || key.endsWith(".zgroup") || key.endsWith(".zattrs") || key.endsWith("zarr.json");

/** zarrita `Store` extension that intercepts metadata to replace as many codecs as possible with workerized variants. */
export const withWorkerCodec = zarr.defineStoreExtension((store, opts: { pool?: TaskPool }) => {
  if (opts?.pool === undefined) {
    return {};
  }
  const { pool } = opts;

  return {
    get: async (key: zarr.AbsolutePath, options?: zarr.GetOptions): Promise<Uint8Array | undefined> => {
      const bytes = await store.get(key, options);

      if (!isMetaKey(key)) {
        return bytes;
      }

      const str = new TextDecoder().decode(bytes);
      try {
        JSON.parse(str);
      } catch (cause) {
        throw new zarr.InvalidMetadataError("Failed to decode JSON", { cause });
      }
    },
  };
});
