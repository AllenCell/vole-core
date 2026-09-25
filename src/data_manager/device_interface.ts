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

// MARK: Three

const dataTypeToThreeTextureProperties: {
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
    const [texType, texFormat, texInternalFormat] = dataTypeToThreeTextureProperties[dtype];
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
    // noop
  }
}

// MARK: WebGPU

export type GPUDeviceHandle = {
  device: GPUDevice;
  queue: GPUQueue;
};

const dataTypeToFormat: { [T in Exclude<NumberType, "int32" | "uint32" | "float64">]: GPUTextureFormat } = {
  int8: "r8snorm",
  int16: "r16snorm",
  uint8: "r8unorm",
  uint16: "r16unorm",
  float32: "r32float",
};

const dataTypeToSize: { [T in NumberType]: number } = {
  int8: 1,
  int16: 2,
  int32: 4,
  uint8: 1,
  uint16: 2,
  uint32: 4,
  float32: 4,
  float64: 8,
};

export class WebGPUInterface implements DeviceInterface<GPUDeviceHandle, GPUTexture> {
  isDeviceHandle(val: unknown): val is GPUDeviceHandle {
    return Array.isArray(val) && val.length === 2 && val[0] instanceof GPUDevice && val[1] instanceof GPUQueue;
  }

  createTexture(
    data: TypedArray,
    dtype: NumberType,
    size: [number, number, number],
    { device, queue }: GPUDeviceHandle
  ): GPUTexture {
    const format = dataTypeToFormat[dtype];
    const texelSize = dataTypeToSize[dtype];
    const texture = device.createTexture({
      format,
      size,
      mipLevelCount: 1,
      sampleCount: 1,
      dimension: "3d",
      // 2 === GPUTextureUsage.COPY_DST; 4 === GPUTextureUsage.TEXTURE_BINDING
      usage: 2 | 4,
    });
    const copyInfo: GPUTexelCopyTextureInfo = {
      texture,
      mipLevel: 0,
      origin: [0, 0, 0],
      aspect: "all",
    };
    const layout: GPUTexelCopyBufferLayout = {
      offset: 0,
      bytesPerRow: texelSize * texture.width,
      rowsPerImage: texture.height,
    };
    queue.writeTexture(copyInfo, data, layout, size);
    return texture;
  }

  destroyTexture(texture: GPUTexture) {
    texture.destroy();
  }

  finishUpdate(): void {
    // noop for now, but this class could be made stateful to e.g. reuse same-sized textures on eviction and use
    // this method to definitively destroy unused textures
  }
}
