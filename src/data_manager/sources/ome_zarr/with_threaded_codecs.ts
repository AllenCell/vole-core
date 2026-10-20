import * as zarr from "zarrita";

import { taskHandle, TaskPool } from "../../task_pool/index.js";
import { defineGlobalId } from "../../utils.js";
import type { encodeTask as encodeTaskType, decodeTask as decodeTaskType } from "./zarr_codec_worker.js";
import type { NumberType } from "../../../types.js";

type CodecKind = "array_to_array" | "array_to_bytes" | "bytes_to_bytes";

// MARK: Codec wrapper

const encodeTask = taskHandle<typeof encodeTaskType>("zarrEncode", (chunk) => [chunk.data.buffer]);
const decodeTask = taskHandle<typeof decodeTaskType>("zarrDecode", (data) => [data.buffer]);

type WorkerConfig = {
  kind: CodecKind;
  codecs: zarr.CodecMetadata[];
};

const getPoolId = defineGlobalId<TaskPool>(Symbol("OMEZarrSource.codecPoolId"));

/**
 * Returns the name of the `zarrita` wrapper codec that runs codec pipelines in the given `pool`.
 *
 * If no such codec exists, this function creates one and registers it with `zarrita`.
 */
const getPoolCodecName = (pool: TaskPool): string => {
  const id = getPoolId(pool);
  const name = `vole-worker-${id}`;

  if (zarr.registry.get(name) === undefined) {
    // Assign every codec pipeline created in this pool a serial number for easy lookup worker-side
    let codecCounter = 0;

    zarr.registry.set(name, async () => ({
      fromConfig: (config, meta) => {
        const { codecs, kind } = config as WorkerConfig;
        const descriptor = { codecs, meta, id: codecCounter };
        codecCounter++;

        return {
          encode: (data: zarr.Chunk<NumberType>) => pool.runTask(encodeTask, data, descriptor),
          decode: (data: Uint8Array) => pool.runTask(decodeTask, data, descriptor),
          kind,
        };
      },
    }));
  }

  return name;
};

// MARK: Metadata parsing

const wrapCodecMetadata = (name: string, meta: zarr.CodecMetadata[]): zarr.CodecMetadata[] => {
  const shardIndex = meta.findIndex(({ name }) => name === "sharding_indexed");
  if (shardIndex > -1) {
    const codecs = meta[shardIndex].configuration.codecs as zarr.CodecMetadata[];
    meta[shardIndex].configuration.codecs = wrapCodecMetadata(name, codecs);
    return meta;
  }
  return [{ name, configuration: { kind: "array_to_bytes", codecs: meta } satisfies WorkerConfig }];
};

/** zarrita `Store` extension that intercepts metadata to replace as many codecs as possible with workerized variants. */
export const withWorkerCodec = zarr.defineStoreExtension((store, opts: { pool?: TaskPool }) => {
  if (opts?.pool === undefined) {
    return {};
  }
  const { pool } = opts;
  const name = getPoolCodecName(pool);

  return {
    get: async (key: zarr.AbsolutePath, options?: zarr.GetOptions): Promise<Uint8Array | undefined> => {
      const bytes = await store.get(key, options);

      if (!key.endsWith("zarr.json")) {
        return bytes;
      }

      const str = new TextDecoder().decode(bytes);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let meta: any;
      try {
        meta = JSON.parse(str);
      } catch (cause) {
        throw new zarr.InvalidMetadataError("Failed to decode JSON", { cause });
      }

      if (meta.zarr_format === 3 && Array.isArray(meta.codecs)) {
        meta.codecs = wrapCodecMetadata(name, meta.codecs);
      }

      const result = JSON.stringify(meta);
      return new TextEncoder().encode(result);
    },
  };
});
