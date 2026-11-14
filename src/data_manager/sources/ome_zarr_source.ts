import * as zarr from "zarrita";

import type { ExtVolumeDims, ChunkSource, VolumeMetadata, GetKeyOptions } from "./chunk_source.js";
import {
  assertMetadataHasMultiscales,
  toOMEZarrMetaV4,
  validateOMEZarrMetadata,
} from "../../loaders/zarr_utils/validation.js";
import type { OMEMultiscale, OmeroTransitionalMetadata } from "../../loaders/zarr_utils/types.js";
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

const PLACEHOLDER_NAME = "zarr source";
const PLACEHOLDER_SCENE_INDEX = 0;

export class OMEZarrSource implements ChunkSource {
  // Magic number that makes `getSourceChannelMeta` (below) work.
  // TODO if/when this class becomes the primary adapter for zarrs, move that util over here and adapt it such that
  //   this property can be removed and the remaining properties can be made `private`.
  public readonly channelOffset = 0;

  private constructor(
    public readonly scaleLevels: zarr.Array<NumberType>[],
    public readonly multiscaleMetadata: OMEMultiscale,
    public readonly omeroMetadata: OmeroTransitionalMetadata | undefined,
    public readonly axesTCZYX: [number, number, number, number, number]
  ) {}

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
    const scaleLevels = (await Promise.all(scaleLevelPromises)) as zarr.Array<NumberType>[];
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

  async getKey(key: LocalChunkId, options: GetKeyOptions): Promise<Chunk[]> {
    const multiscale = this.scaleLevels[key.multiscale];
    const [keyT, keyC, idZ, idY, idX] = key.tczyx;

    // If this chunk contains more than one timepoint and/or channel, we need to know how to separate them.
    // TODO this source doesn't know how to reorder the chunk it receives, and will fail when...
    //   1. The T and/or C dimension is ordered after at least one spatial dimension (e.g. ZCYX)
    //   2. At least one spatial dimension that comes before T or C (e.g. Z in ZCYX) has chunk shape > 1
    //   3. At least one of T or C that comes after a spatial dimension (e.g. C in ZCYX) has chunk shape > 1
    // For absolute maximum robustness, this method would recognize that case and call `reorderChunk` before separating
    //   chunks. I haven't implemented this because I could find no zarrs that actually fit these nonstandard
    //   conditions, but if we encounter one in the future, this is the spot to add support for it.
    const [shapeT, shapeC] = orderByTCZYX(multiscale.chunks, this.axesTCZYX, 1);
    const [sizeT, sizeC] = orderByTCZYX(multiscale.shape, this.axesTCZYX, 1);
    // Does C come before T in the dimension order?
    const [orderT, orderC] = this.axesTCZYX;
    const cMinor = shapeT > 1 && shapeC > 1 && orderT > -1 && orderC > -1 && orderC < orderT;

    const tMin = keyT * shapeT;
    const cMin = keyC * shapeC;
    // Account for max-edge chunks
    // (e.g. if each chunk has 2 channels and there are 5 channels total, the last chunk has one channel)
    const chunksT = Math.min(shapeT, sizeT - tMin);
    const chunksC = Math.min(shapeC, sizeC - cMin);
    const chunkCount = chunksT * chunksC;
    const majorLength = cMinor ? chunksT : chunksC;

    const coords = orderByDimension(key.tczyx, this.axesTCZYX);
    const { data } = await multiscale.getChunk(coords, { signal: options?.signal });

    const chunkLength = data.length / chunkCount;
    const result: Chunk[] = [];

    for (let i = 0; i < chunkCount; i++) {
      const chunkStart = i * chunkLength;
      const subarray = (data as TypedArray).slice(chunkStart, chunkStart + chunkLength);
      const offsetMinor = Math.floor(i / majorLength);
      const offsetMajor = i % majorLength;
      const [idT, idC] = cMinor ? [tMin + offsetMajor, cMin + offsetMinor] : [tMin + offsetMinor, cMin + offsetMajor];
      const id: LocalChunkId = { multiscale: key.multiscale, tczyx: [idT, idC, idZ, idY, idX] };
      result.push({ data: subarray, dtype: multiscale.dtype, id });
    }

    return result;
  }
}
