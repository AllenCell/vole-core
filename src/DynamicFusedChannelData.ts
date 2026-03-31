import {
  Box3,
  ClampToEdgeWrapping,
  CustomBlending,
  Data3DTexture,
  DataTexture,
  LinearFilter,
  MaxEquation,
  OneFactor,
  OrthographicCamera,
  PlaneGeometry,
  RedFormat,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  ShaderMaterialParameters,
  Texture,
  UnsignedByteType,
  Vector2,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { renderToBufferVertShader } from "./constants/basicShaders";
import { NumberType } from "./types";
import fuseShaderSrcUI from "./constants/shaders/dynamic_fuseUI.frag";

type ChannelSettings = {
  index: number;
  lut: Uint8Array;
  color: [number, number, number];
};

type ChunkInfo = {
  texture: Data3DTexture;
  channelIndex: number;
  extent: Box3;
};

const FUSE_MATERIAL_PROPS: Partial<ShaderMaterialParameters> = {
  vertexShader: renderToBufferVertShader,
  depthTest: false,
  depthWrite: false,
  blending: CustomBlending,
  blendSrc: OneFactor,
  blendDst: OneFactor,
  blendEquation: MaxEquation,
};

const setupFuseMaterial = (src: string): ShaderMaterial =>
  new ShaderMaterial({
    uniforms: {
      lutSampler: { value: null },
      lutMinMax: { value: new Vector2(0, 255) },
      srcTexture: { value: null },
    },
    fragmentShader: src,
    ...FUSE_MATERIAL_PROPS,
  });

export default class DynamicFusedChannelData {
  public width: number;
  public height: number;
  public maskTexture: DataTexture;

  private fuseGeometry: PlaneGeometry;
  private fuseMaterialF: ShaderMaterial;
  private fuseMaterialUI: ShaderMaterial;
  private fuseMaterialI: ShaderMaterial;

  private fuseScene: Scene;
  private quadCamera: OrthographicCamera;
  private fuseRenderTarget: WebGLRenderTarget;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;

    this.maskTexture = new DataTexture(
      new Uint8ClampedArray(this.width * this.height).fill(255),
      this.width,
      this.height,
      RedFormat,
      UnsignedByteType
    );
    this.maskTexture.generateMipmaps = false;
    this.maskTexture.magFilter = LinearFilter;
    this.maskTexture.minFilter = LinearFilter;
    this.maskTexture.wrapS = ClampToEdgeWrapping;
    this.maskTexture.wrapT = ClampToEdgeWrapping;
    // for single-channel tightly packed array data:
    this.maskTexture.unpackAlignment = 1;

    this.fuseScene = new Scene();
    this.quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.fuseRenderTarget = new WebGLRenderTarget(this.width, this.height, {
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      format: RGBAFormat,
      type: UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
    });

    this.fuseMaterialF = setupFuseMaterial(fuseShaderSrcUI);
    this.fuseMaterialUI = setupFuseMaterial(fuseShaderSrcUI);
    this.fuseMaterialI = setupFuseMaterial(fuseShaderSrcUI);
  }

  getFusedTexture(): Texture {
    return this.fuseRenderTarget.texture;
  }

  cleanup(): void {
    this.fuseScene.clear();
    this.maskTexture.dispose();
  }

  private getShader(dtype: NumberType): ShaderMaterial {
    switch (dtype) {
      case "float32":
        return this.fuseMaterialF;
      case "uint8":
      case "uint16":
      case "uint32":
        return this.fuseMaterialUI;
      case "int8":
      case "int16":
      case "int32":
        return this.fuseMaterialI;
      default:
        throw new Error("Unsupported data type for fuse shader");
    }
  }

  gpuFuse(renderer: WebGLRenderer): void {}
}
