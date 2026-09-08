import * as zarr from "zarrita";

import { type ExtVolumeDims, ChunkSource, type VolumeMetadata } from "./ChunkSource.js";
import {
  assertMetadataHasMultiscales,
  toOMEZarrMetaV4,
  validateOMEZarrMetadata,
} from "../../loaders/zarr_utils/validation.js";
import type { NumericZarrArray, OMEMultiscale, OmeroTransitionalMetadata } from "../../loaders/zarr_utils/types.js";
import {
  getScale,
  getSourceChannelMeta,
  orderByDimension,
  orderByTCZYX,
  remapAxesToTCZYX,
} from "../../loaders/zarr_utils/utils.js";
import { unitNameToSymbol } from "../../loaders/VolumeLoaderUtils.js";
import type { Chunk, LocalChunkId } from "../types.js";
import type { NumberType, TypedArray } from "../../types.js";
import { taskHandle } from "../task_pool/task.js";
import type { ZarrEncodeTask, ZarrDecodeTask } from "./zarr_codec_worker.js";
import { TaskPool } from "../task_pool/TaskPool.js";

const PLACEHOLDER_NAME = "zarr source";
const PLACEHOLDER_SCENE_INDEX = 0;

export class OMEZarrSource extends ChunkSource {
  // Magic number that makes `getSourceChannelMeta` (below) work.
  // TODO if/when this class becomes the primary adapter for zarrs, move that util over here and adapt it such that
  //   this property can be removed and the remaining properties can be made `private`.
  public readonly channelOffset = 0;

  private constructor(
    public readonly scaleLevels: NumericZarrArray[],
    public readonly multiscaleMetadata: OMEMultiscale,
    public readonly omeroMetadata: OmeroTransitionalMetadata | undefined,
    public readonly axesTCZYX: [number, number, number, number, number]
  ) {
    super();
  }

  static async new(url: string): Promise<OMEZarrSource> {
    const store = new zarr.FetchStore(url);
    const root = zarr.root(store);

    const group = await zarr.open(root, { kind: "group" });
    const meta = toOMEZarrMetaV4(group.attrs);
    assertMetadataHasMultiscales(meta, PLACEHOLDER_NAME);
    validateOMEZarrMetadata(meta, PLACEHOLDER_SCENE_INDEX, PLACEHOLDER_NAME);

    const { multiscales, omero } = meta;
    const multiscaleMetadata = multiscales[PLACEHOLDER_SCENE_INDEX];

    // Open all scale levels of multiscale
    const scaleLevelPromises = multiscaleMetadata.datasets.map(({ path }) =>
      zarr.open(root.resolve(path), { kind: "array" })
    );
    const scaleLevels = (await Promise.all(scaleLevelPromises)) as NumericZarrArray[];
    const axesTCZYX = remapAxesToTCZYX(multiscaleMetadata.axes);
    return new OMEZarrSource(scaleLevels, multiscaleMetadata, omero, axesTCZYX);
  }

  private getUnitSymbols(): [string, string] {
    // Assume all spatial axes in all sources have the same units - we have no means of storing per-axis unit symbols
    const xi = this.axesTCZYX[4];
    const spaceUnitName = this.multiscaleMetadata.axes[xi].unit;
    const spaceUnitSymbol = unitNameToSymbol(spaceUnitName) || spaceUnitName || "";

    const ti = this.axesTCZYX[0];
    const timeUnitName = ti > -1 ? this.multiscaleMetadata.axes[ti].unit : undefined;
    const timeUnitSymbol = unitNameToSymbol(timeUnitName) || timeUnitName || "";

    return [spaceUnitSymbol, timeUnitSymbol];
  }

  chunkIdToStorageId({ multiscale, tczyx: [t, c, z, y, x] }: LocalChunkId): LocalChunkId {
    const level = this.scaleLevels[multiscale];
    const [shapeT, shapeC] = orderByTCZYX(level.chunks, this.axesTCZYX, 1);
    const keyT = Math.floor(t / shapeT);
    const keyC = Math.floor(c / shapeC);
    return { multiscale, tczyx: [keyT, keyC, z, y, x] };
  }

  storageIdToChunkIds({ multiscale, tczyx: [t, c, z, y, x] }: LocalChunkId): LocalChunkId[] {
    const level = this.scaleLevels[multiscale];
    const [shapeT, shapeC] = orderByTCZYX(level.chunks, this.axesTCZYX, 1);

    const minT = t * shapeT;
    const maxT = minT + shapeT;
    const minC = c * shapeC;
    const maxC = minC + shapeC;

    const chunksInKey: LocalChunkId[] = [];
    for (let chunkT = minT; chunkT < maxT; chunkT++) {
      for (let chunkC = minC; chunkC < maxC; chunkC++) {
        chunksInKey.push({ multiscale, tczyx: [chunkT, chunkC, z, y, x] });
      }
    }
    return chunksInKey;
  }

  getMeta(): VolumeMetadata {
    const { names: channelNames, colors: channelColors } = getSourceChannelMeta(this);

    return {
      name: this.omeroMetadata?.name ?? PLACEHOLDER_NAME,
      channelNames,
      channelColors,
      transform: {
        translation: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
    };
  }

  getDims(): ExtVolumeDims[] {
    const [spaceUnit, timeUnit] = this.getUnitSymbols();
    return this.scaleLevels.map((level, i) => {
      const scale = getScale(this.multiscaleMetadata.datasets[i], this.axesTCZYX);
      return {
        spaceUnit,
        timeUnit,
        shape: orderByTCZYX(level.shape, this.axesTCZYX, 1),
        chunkShape: orderByTCZYX(level.chunks, this.axesTCZYX, 1),
        spacing: orderByTCZYX(scale, this.axesTCZYX, 1),
        dataType: level.dtype,
      };
    });
  }

  async getKey(id: LocalChunkId, signal?: AbortSignal): Promise<Chunk<NumberType>[]> {
    const multiscale = this.scaleLevels[id.multiscale];
    const coords = orderByDimension(id.tczyx, this.axesTCZYX);
    const { data } = (await multiscale.getChunk(coords, { signal })) as { data: TypedArray<NumberType> };
    return [{ data, dtype: multiscale.dtype, id }];
  }
}

let codecCounter = 0;

const encodeTask = taskHandle<ZarrEncodeTask>("zarrEncode", (data) => [data.buffer]);
const decodeTask = taskHandle<ZarrDecodeTask>("zarrDecode", (data) => [data.buffer]);

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

const pool = new TaskPool();
augmentCodec("numcodecs.blosc", pool);
