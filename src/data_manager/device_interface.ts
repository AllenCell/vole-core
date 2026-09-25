import {
  ByteType,
  Data3DTexture,
  FloatType,
  IntType,
  type PixelFormat,
  PixelFormatGPU,
  RedFormat,
  RedIntegerFormat,
  ShortType,
  type TextureDataType,
  UnsignedByteType,
  UnsignedIntType,
  UnsignedShortType,
} from "three";

import type { NumberType, TypedArray } from "../types.js";

export interface DeviceInterface<Dev, Tex> {
  isDeviceHandle(val: unknown): val is Dev;
  createTexture(data: TypedArray, dtype: NumberType, size: [number, number, number], deviceHandle: Dev): Tex;
  destroyTexture(tex: Tex): void;
  finishUpdate(): void;
}

const dataTypeToTextureProperties: {
  [T in Exclude<NumberType, "float64">]: [TextureDataType, PixelFormat, PixelFormatGPU];
} = {
  int8: [ByteType, RedIntegerFormat, "R8I"],
  int16: [ShortType, RedIntegerFormat, "R16I"],
  int32: [IntType, RedIntegerFormat, "R32I"],
  uint8: [UnsignedByteType, RedIntegerFormat, "R8UI"],
  uint16: [UnsignedShortType, RedIntegerFormat, "R16UI"],
  uint32: [UnsignedIntType, RedIntegerFormat, "R32UI"],
  float32: [FloatType, RedFormat, "R32F"],
};

export class ThreeInterface implements DeviceInterface<void, Data3DTexture> {
  isDeviceHandle(_val: unknown): _val is void {
    return true;
  }

  createTexture(data: TypedArray, dtype: NumberType, [x, y, z]: [number, number, number]) {
    const [texType, texFormat, texInternalFormat] = dataTypeToTextureProperties[dtype];
    const texture = new Data3DTexture(data, x, y, z);
    texture.type = texType;
    texture.format = texFormat;
    texture.internalFormat = texInternalFormat;
    texture.needsUpdate = true;
    return texture;
  }

  destroyTexture(tex: Data3DTexture): void {
    tex.dispose();
  }

  finishUpdate() {
    /* noop */
  }
}
