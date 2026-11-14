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
