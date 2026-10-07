import type { NumberType } from "../../types.js";
import type { VolumeDims } from "../../VolumeDims.js";
import { type Chunk, type LocalChunkId } from "../types.js";

// TODO not modifying original `VolumeDims` for compatibility, but at some point this will either need to be
//   incorporated into `VolumeDims` or replaced with an entirely new type
export type ExtVolumeDims = VolumeDims & { chunkShape: [number, number, number, number, number] };

// This is more or less the subset of `ImageInfo` that is *not* derivable from `[Ext]VolumeDims` and is therefore *not*
//   essential to handling volume data and rendering it at the correct scale.
export type VolumeMetadata = {
  name?: string;
  channelNames: string[];
  channelColors?: ([number, number, number] | undefined)[];
  transform: {
    translation: [number, number, number];
    rotation: [number, number, number];
    scale: [number, number, number];
  };
  userData?: Record<string, unknown>;
};

export abstract class ChunkSource {
  /**
   * Maps a chunk `id` to the *storage key* that contains it.
   *
   * In most cases, a chunk id and its storage key are the same. However, `DataManager` requires that chunks extend
   * over exactly one channel and exactly one time point, and some data formats may allow multiple channels and/or time
   * points to be stored at the same storage key.
   */
  chunkIdToStorageId(id: LocalChunkId): LocalChunkId {
    return id;
  }

  /** Maps a storage key to a list of the chunk ids it contains. */
  storageIdToChunkIds(id: LocalChunkId): LocalChunkId[] {
    return [id];
  }

  abstract getMeta(): VolumeMetadata;

  abstract getDims(): ExtVolumeDims[];

  abstract getKey(key: LocalChunkId, signal?: AbortSignal): Promise<Chunk<NumberType>[]>;
}
