import {
  Box3,
  Box3Helper,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DepthTexture,
  Group,
  LineBasicMaterial,
  LineSegments,
  Material,
  Matrix4,
  Mesh,
  OrthographicCamera,
  PerspectiveCamera,
  ShaderMaterial,
  Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";

import {
  rayMarchingVertexShaderSrc,
  rayMarchingFragmentShaderSrc,
  rayMarchingShaderUniforms,
} from "./constants/volumeRayMarchShader.js";
import { Volume } from "./index.js";
import Channel from "./Channel.js";
import type { VolumeRenderImpl } from "./VolumeRenderImpl.js";

import type { FuseChannel } from "./types.js";
import { VolumeRenderSettings, SettingsFlags } from "./VolumeRenderSettings.js";
import DynamicFusedChannelData from "./DynamicFusedChannelData.js";

const BOUNDING_BOX_DEFAULT_COLOR = new Color(0xffff00);

export default class RayMarchedAtlasVolume implements VolumeRenderImpl {
  private settings: VolumeRenderSettings;
  public volume: Volume;

  private geometry: BoxGeometry;
  private geometryMesh: Mesh<BufferGeometry, Material>;
  private boxHelper: Box3Helper;
  private tickMarksMesh: LineSegments;
  private geometryTransformNode: Group;
  private uniforms: ReturnType<typeof rayMarchingShaderUniforms>;
  private channelData!: DynamicFusedChannelData;
  private emptyPositionTex: DataTexture;

  /**
   * Creates a new RayMarchedAtlasVolume.
   * @param volume The volume that this renderer should render data from.
   * @param settings Optional settings object. If set, updates the renderer with
   * the given settings. Otherwise, uses the default VolumeRenderSettings.
   */
  constructor(volume: Volume, settings: VolumeRenderSettings = new VolumeRenderSettings(volume)) {
    this.volume = volume;

    this.uniforms = rayMarchingShaderUniforms();
    [this.geometry, this.geometryMesh] = this.createGeometry(this.uniforms);

    this.boxHelper = new Box3Helper(
      new Box3(new Vector3(-0.5, -0.5, -0.5), new Vector3(0.5, 0.5, 0.5)),
      BOUNDING_BOX_DEFAULT_COLOR
    );
    this.boxHelper.updateMatrixWorld();
    this.boxHelper.visible = false;

    this.tickMarksMesh = this.createTickMarks();
    this.tickMarksMesh.updateMatrixWorld();
    this.tickMarksMesh.visible = false;

    this.geometryTransformNode = new Group();
    this.geometryTransformNode.name = "VolumeContainerNode";

    this.geometryTransformNode.add(this.boxHelper, this.tickMarksMesh, this.geometryMesh);

    this.emptyPositionTex = new DataTexture(new Uint8Array(Array(16).fill(0)), 2, 2);

    this.settings = settings;
    this.updateSettings(settings, SettingsFlags.ALL);
    // TODO this is doing *more* redundant work! Fix?
    this.updateVolumeDimensions();
  }

  public updateVolumeDimensions(): void {
    const { normPhysicalSize, normRegionSize } = this.volume;
    // Set offset
    this.geometryMesh.position.copy(this.volume.getContentCenter().multiply(this.settings.scale));
    // Set scale
    const fullRegionScale = normPhysicalSize.clone().multiply(this.settings.scale);
    this.geometryMesh.scale.copy(fullRegionScale).multiply(normRegionSize);
    this.setUniform("volumeScale", normPhysicalSize);
    this.boxHelper.box.set(fullRegionScale.clone().multiplyScalar(-0.5), fullRegionScale.clone().multiplyScalar(0.5));
    this.tickMarksMesh.scale.copy(fullRegionScale);
    this.settings && this.updateSettings(this.settings, SettingsFlags.ROI);

    // Set atlas dimension uniforms
    const { atlasTileDims, subregionSize } = this.volume.imageInfo;
    const atlasSize = new Vector2(subregionSize.x, subregionSize.y).multiply(atlasTileDims);

    this.setUniform("ATLAS_DIMS", atlasTileDims);

    this.setUniform("textureRes", atlasSize);
    this.setUniform("SLICES", this.volume.imageInfo.volumeSize.z);

    // (re)create channel data
    if (!this.channelData || this.channelData.width !== atlasSize.x || this.channelData.height !== atlasSize.y) {
      this.channelData?.cleanup();
      this.channelData = new DynamicFusedChannelData(atlasSize.x, atlasSize.y);
    }
  }

  public viewpointMoved(): void {
    return;
  }

  public updateSettings(newSettings: VolumeRenderSettings, dirtyFlags?: number | SettingsFlags) {
    if (dirtyFlags === undefined) {
      dirtyFlags = SettingsFlags.ALL;
    }

    this.settings = newSettings;

    if (dirtyFlags & SettingsFlags.VIEW) {
      this.geometryMesh.visible = this.settings.visible;
      // Configure ortho
      this.setUniform("orthoScale", this.settings.orthoScale);
      this.setUniform("isOrtho", this.settings.isOrtho ? 1.0 : 0.0);
      // Ortho line thickness
      const axis = this.settings.viewAxis;
      if (this.settings.isOrtho && axis) {
        // TODO: Does this code do any relevant changes?
        const maxVal = this.settings.bounds.bmax[axis];
        const minVal = this.settings.bounds.bmin[axis];
        const thicknessPct = maxVal - minVal;
        this.setUniform("orthoThickness", thicknessPct);
      } else {
        this.setUniform("orthoThickness", 1.0);
      }
    }

    if (dirtyFlags & SettingsFlags.VIEW || dirtyFlags & SettingsFlags.BOUNDING_BOX) {
      // Update tick marks with either view or bounding box changes
      this.tickMarksMesh.visible = this.settings.showBoundingBox && !this.settings.isOrtho;
      this.setUniform("maxProject", this.settings.maxProjectMode ? 1 : 0);
    }

    if (dirtyFlags & SettingsFlags.BOUNDING_BOX) {
      // Configure bounding box
      this.boxHelper.visible = this.settings.showBoundingBox;
      const colorVector = this.settings.boundingBoxColor;
      const newBoxColor = new Color(colorVector[0], colorVector[1], colorVector[2]);
      (this.boxHelper.material as LineBasicMaterial).color = newBoxColor;
      (this.tickMarksMesh.material as LineBasicMaterial).color = newBoxColor;
    }

    if (dirtyFlags & SettingsFlags.TRANSFORM) {
      // Set rotation and translation
      this.geometryTransformNode.position.copy(this.settings.translation);
      this.geometryTransformNode.rotation.copy(this.settings.rotation);
      // TODO this does some redundant work. Including a new call to this very function! Fix?
      this.updateVolumeDimensions();
      this.setUniform("flipVolume", this.settings.flipAxes);
    }

    if (dirtyFlags & SettingsFlags.MATERIAL) {
      this.setUniform("DENSITY", this.settings.density);
    }

    if (dirtyFlags & SettingsFlags.CAMERA) {
      // TODO brightness and exposure should be the same thing?
      this.setUniform("BRIGHTNESS", this.settings.brightness * 2.0);
      // Gamma
      this.setUniform("GAMMA_MIN", this.settings.gammaMin);
      this.setUniform("GAMMA_MAX", this.settings.gammaMax);
      this.setUniform("GAMMA_SCALE", this.settings.gammaLevel);
    }

    if (dirtyFlags & SettingsFlags.ROI) {
      // Normalize and set bounds
      const bounds = this.settings.bounds;
      const { normRegionSize, normRegionOffset } = this.volume;
      const offsetToCenter = normRegionSize.clone().divideScalar(2).add(normRegionOffset).subScalar(0.5);
      const bmin = bounds.bmin.clone().sub(offsetToCenter).divide(normRegionSize).clampScalar(-0.5, 0.5);
      const bmax = bounds.bmax.clone().sub(offsetToCenter).divide(normRegionSize).clampScalar(-0.5, 0.5);

      this.setUniform("AABB_CLIP_MIN", bmin);
      this.setUniform("AABB_CLIP_MAX", bmax);
    }

    if (dirtyFlags & SettingsFlags.SAMPLING) {
      this.setUniform("interpolationEnabled", this.settings.useInterpolation);
      this.setUniform("iResolution", this.settings.resolution);
    }

    if (dirtyFlags & SettingsFlags.MASK_ALPHA) {
      this.setUniform("maskAlpha", this.settings.maskChannelIndex < 0 ? 1.0 : this.settings.maskAlpha);
    }
    if (dirtyFlags & SettingsFlags.MASK_DATA) {
      this.channelData.setChannelAsMask(
        this.settings.maskChannelIndex,
        this.volume.getChannel(this.settings.maskChannelIndex)
      );
    }
  }

  /**
   * Creates the geometry mesh and material for rendering the volume.
   * @param uniforms object containing uniforms to pass to the shader material.
   * @returns the new geometry and geometry mesh.
   */
  private createGeometry(
    uniforms: ReturnType<typeof rayMarchingShaderUniforms>
  ): [BoxGeometry, Mesh<BufferGeometry, Material>] {
    const geom = new BoxGeometry(1.0, 1.0, 1.0);

    // shader,vtx and frag.

    const threeMaterial = new ShaderMaterial({
      uniforms: uniforms,
      vertexShader: rayMarchingVertexShaderSrc,
      fragmentShader: rayMarchingFragmentShaderSrc,
      transparent: true,
      depthTest: true,
      depthWrite: false,
    });
    const mesh: Mesh<BufferGeometry, Material> = new Mesh(geom, threeMaterial);
    mesh.name = "Volume";

    return [geom, mesh];
  }

  private createTickMarks(): LineSegments {
    // Length of tick mark lines in world units
    const TICK_LENGTH = 0.025;
    const { tickMarkPhysicalLength, physicalScale, normPhysicalSize } = this.volume;
    const numTickMarks = physicalScale / tickMarkPhysicalLength;

    const vertices: number[] = [];

    const tickEndY = TICK_LENGTH / normPhysicalSize.y + 0.5;
    const tickSpacingX = 1 / (normPhysicalSize.x * numTickMarks);
    for (let x = -0.5; x <= 0.5; x += tickSpacingX) {
      // prettier-ignore
      vertices.push(
        x, 0.5,       0.5,
        x, tickEndY,  0.5,

        x, -0.5,      -0.5,
        x, -tickEndY, -0.5,

        x, 0.5,       -0.5,
        x, tickEndY,  -0.5,

        x, -0.5,      0.5,
        x, -tickEndY, 0.5,
      );
    }

    const tickEndX = TICK_LENGTH / normPhysicalSize.x + 0.5;
    const tickSpacingY = 1 / (normPhysicalSize.y * numTickMarks);
    for (let y = 0.5; y >= -0.5; y -= tickSpacingY) {
      // prettier-ignore
      vertices.push(
        -0.5,      y, 0.5,
        -tickEndX, y, 0.5,

        -0.5,      y, -0.5,
        -tickEndX, y, -0.5,

        0.5,       y, -0.5,
        tickEndX,  y, -0.5,

        0.5,       y, 0.5,
        tickEndX,  y, 0.5,
      );
    }

    const tickSpacingZ = 1 / (normPhysicalSize.z * numTickMarks);
    for (let z = 0.5; z >= -0.5; z -= tickSpacingZ) {
      // prettier-ignore
      vertices.push(
        -0.5,      0.5,  z,
        -tickEndX, 0.5,  z,

        -0.5,      -0.5, z,
        -tickEndX, -0.5, z,

        0.5,       -0.5, z,
        tickEndX,  -0.5, z,

        0.5,       0.5,  z,
        tickEndX,  0.5,  z,
      );
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(vertices), 3));
    return new LineSegments(geometry, new LineBasicMaterial({ color: BOUNDING_BOX_DEFAULT_COLOR }));
  }

  public cleanup(): void {
    this.geometry.dispose();
    this.geometryMesh.material.dispose();

    this.channelData.cleanup();
  }

  public doRender(
    renderer: WebGLRenderer,
    camera: PerspectiveCamera | OrthographicCamera,
    depthTexture?: DepthTexture | Texture | null
  ): void {
    if (!this.geometryMesh.visible) {
      return;
    }

    const depthTex = depthTexture ?? this.emptyPositionTex;
    this.setUniform("textureDepth", depthTex);
    this.setUniform("usingPositionTexture", (depthTex as DepthTexture).isDepthTexture ? 0 : 1);
    this.setUniform("CLIP_NEAR", camera.near);
    this.setUniform("CLIP_FAR", camera.far);

    this.channelData.gpuFuse(renderer);
    this.setUniform("textureAtlas", this.channelData.getFusedTexture());

    this.geometryTransformNode.updateMatrixWorld(true);

    const mvm = new Matrix4();
    mvm.multiplyMatrices(camera.matrixWorldInverse, this.geometryMesh.matrixWorld);
    mvm.invert();

    this.setUniform("inverseModelViewMatrix", mvm);
    this.setUniform("inverseProjMatrix", camera.projectionMatrixInverse);
  }

  public get3dObject(): Group {
    return this.geometryTransformNode;
  }

  //////////////////////////////////////////
  //////////////////////////////////////////

  private setUniform<U extends keyof ReturnType<typeof rayMarchingShaderUniforms>>(
    name: U,
    value: ReturnType<typeof rayMarchingShaderUniforms>[U]["value"]
  ) {
    if (!this.uniforms[name]) {
      return;
    }
    this.uniforms[name].value = value;
  }

  // channelcolors is array of {rgbColor, lut} and channeldata is volume.channels
  public updateActiveChannels(channelcolors: FuseChannel[], channeldata: Channel[]): void {
    this.channelData.fuse(channelcolors, channeldata);

    // update to fused texture
    this.setUniform("textureAtlas", this.channelData.getFusedTexture());
    this.setUniform("textureAtlasMask", this.channelData.maskTexture);
  }

  public setRenderUpdateListener(_listener?: ((iteration: number) => void) | undefined) {
    return;
  }
}
