import { ARRAY_CONSTRUCTORS } from "../../types.js";
import { NumericZarrArray } from "./types.js";

export function getChunkByteSize(level: NumericZarrArray): number {
  const voxelsPerChunk = level.chunks.reduce((accumulator, chunkSize) => accumulator * chunkSize, 1);
  return voxelsPerChunk * ARRAY_CONSTRUCTORS[level.dtype].BYTES_PER_ELEMENT;
}

/**
 * @param level One resolution level of a ZARR
 * @yields One coords array per chunk in the level
 */
export function* iterateChunkCoords(level: NumericZarrArray): Generator<number[]> {
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