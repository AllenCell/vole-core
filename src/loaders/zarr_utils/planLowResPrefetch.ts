import { ARRAY_CONSTRUCTORS } from "../../types.js";
import { NumericZarrArray, ZarrSource } from "./types.js";

function getByteSize(level, shape): number {
  const voxels = shape.reduce((accumulator, dim) => accumulator * dim, 1);
  return voxels * ARRAY_CONSTRUCTORS[level.dtype].BYTES_PER_ELEMENT;
}

function getTotalByteSize(level: NumericZarrArray): number {
  return getByteSize(level, level.shape);
}

function getChunkByteSize(level: NumericZarrArray): number {
  return getByteSize(level, level.chunks);
}

/**
 * @param level One resolution level of a ZARR
 * @yields One coords array per chunk in the level
 */
function* iterateChunkCoords(level: NumericZarrArray): Generator<number[]> {
  // level.chunks[dimension] is the width of a chunk in the given dimenion
  const chunksPerDimension = level.shape.map((size, dimension) => Math.ceil(size / level.chunks[dimension]));

  /**
   * @param coords A partial coordinates array (e.g., [1,2,3])
   * @yields Coordinates arrays that start with the values in coords (e.g., [1,2,3,4,5])
   */
  function* iterateCoordsWithPrefix(coords: number[]): Generator<number[]> {
    const nextDimension = coords.length;
    if (nextDimension === chunksPerDimension.length) {
      // coords is fully filled out with values in all dimensions
      yield coords;
      return;
    }

    for (let thisDimIdx = 0; thisDimIdx < chunksPerDimension[nextDimension]; thisDimIdx++) {
      yield* iterateCoordsWithPrefix([...coords, thisDimIdx]);
    }
  }

  yield* iterateCoordsWithPrefix([]);
}

export type PlannedChunk = {
  sourceIndex: number,
  level: NumericZarrArray,
  coords: number[]
};

export default function planLowResPrefetch(sources: ZarrSource[], availableBytes: number, minimumCachedExtent: number): { plan: PlannedChunk[], availableBytes: number } {
    const plan: PlannedChunk[] = [];
    for (const [sourceIndex, source] of sources.entries()) {
      // Known brittleness: this line and vole-app's useVolume.ts pick the same level for low-res
      // pre-fetching and low-res display by selecting the coarsest level, which relies on both
      // implementations having similar logic. (See also public/index.ts.)
      const level = source.scaleLevels[source.scaleLevels.length - 1];
      if (getTotalByteSize(level) * minimumCachedExtent > availableBytes) {
        continue; // Skip this source: maybe another one is smaller
      }
      const chunkBytes = getChunkByteSize(level);
      for (const coords of iterateChunkCoords(level)) {
        if (chunkBytes > availableBytes) {
          break;
        }
        plan.push({ sourceIndex, level, coords });
        availableBytes -= chunkBytes;
      }
    }
    return { plan, availableBytes };
}
