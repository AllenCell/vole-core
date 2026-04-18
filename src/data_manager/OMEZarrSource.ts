import * as zarr from "zarrita";

import { RelaxedFetchStore } from "../loaders/zarr_utils/wrappers.js";
import type { ExtVolumeDims, IChunkSource } from "./DataManager.js";
import {
  assertMetadataHasMultiscales,
  toOMEZarrMetaV4,
  validateOMEZarrMetadata,
} from "../loaders/zarr_utils/validation.js";
import type { NumericZarrArray, OMEMultiscale, OmeroTransitionalMetadata } from "../loaders/zarr_utils/types.js";
import { getScale, orderByDimension, orderByTCZYX, remapAxesToTCZYX } from "../loaders/zarr_utils/utils.js";
import { unitNameToSymbol } from "../loaders/VolumeLoaderUtils.js";
import type { Chunk, LocalChunkId } from "./types.js";
import type { NumberType } from "../types.js";

const PLACEHOLDER_NAME = "zarr source";
const PLACEHOLDER_SCENE_INDEX = 0;

export default class OMEZarrSource implements IChunkSource {
  private constructor(
    private scaleLevels: NumericZarrArray[],
    private multiscaleMetadata: OMEMultiscale,
    private omeroMetadata: OmeroTransitionalMetadata | undefined,
    private axesTCZYX: [number, number, number, number, number]
  ) {}

  static async new(url: string): Promise<OMEZarrSource> {
    const store = new RelaxedFetchStore(url);
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

  async getChunk(chunkId: LocalChunkId): Promise<Chunk<NumberType>> {
    const multiscale = this.scaleLevels[chunkId.multiscale];
    const coords = orderByDimension(chunkId.tczyx, this.axesTCZYX);
    const { data } = await multiscale.getChunk(coords);
    return { data, dtype: multiscale.dtype };
  }
}
