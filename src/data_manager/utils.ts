import type { NumberType } from "../types.js";
import type { ExtVolumeDims } from "./sources/chunk_source.js";
import type { LocalChunkId } from "./types.js";

export const dataTypeToSize: { [T in NumberType]: number } = {
  int8: 1,
  int16: 2,
  int32: 4,
  uint8: 1,
  uint16: 2,
  uint32: 4,
  float32: 4,
  float64: 8,
};

/** Creates a function that returns a stable and globally unique number for any object passed to it. */
export const defineGlobalId = <T extends object = object>(key: symbol): ((obj: T) => number) => {
  let id = 0;
  return (obj: T): number => {
    if (obj[key] === undefined) {
      obj[key] = id;
      id += 1;
    }
    return obj[key];
  };
};

/** Removes an element from an array by replacing it with the element at the end of the array. */
export const swapRemove = <T>(arr: T[], index: number) => {
  if (index < 0 || index >= arr.length) {
    return;
  }

  const { length } = arr;
  const replace = arr.pop();
  if (replace !== undefined && index < length) {
    arr[index] = replace;
  }
};

// TODO should this go in `types`, or should more `types` functions go in `util`?
// TODO could be implemented in terms of utils in `adapter_loader`?
export const getChunkDims = (
  chunkId: LocalChunkId,
  dims: ExtVolumeDims
): { x: number; y: number; z: number; dataType: NumberType } => {
  const { shape, chunkShape, dataType } = dims;

  const [, , iz, iy, ix] = chunkId.tczyx;
  const [, , cz, cy, cx] = chunkShape;
  const [, , sz, sy, sx] = shape;
  // Chunks that abut the max edge of the volume in any dimension may be smaller in that dimension.
  // e.g. for a volume with chunk size 10 & volume size 35 in x, chunks at x = 3 have size 5 in x.
  const z = Math.min(cz, sz - cz * iz);
  const y = Math.min(cy, sy - cy * iy);
  const x = Math.min(cx, sx - cx * ix);
  return { x, y, z, dataType };
};
