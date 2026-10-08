import type { NumberType } from "../types.js";

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
