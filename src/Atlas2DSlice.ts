import {
  Box3,
  Box3Helper,
  BufferGeometry,
  Color,
  Group,
  LineBasicMaterial,
  Material,
  Matrix4,
  Mesh,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import type Channel from "./Channel.js";
import type Volume from "./Volume.js";
import { sliceFragmentShaderSrc, sliceShaderUniforms, sliceVertexShaderSrc } from "./constants/volumeSliceShader.js";
import type { VolumeRenderImpl } from "./VolumeRenderImpl.js";
import { SettingsFlags, VolumeRenderSettings } from "./VolumeRenderSettings.js";
import FusedChannelData from "./FusedChannelData.js";
import { Axis, type AxisName, type FuseChannel } from "./types.js";

const BOUNDING_BOX_DEFAULT_COLOR = new Color(0xffff00);

/** Maps the slice axis to the integer expected by the viewAxis shader uniform. */
function axisToShaderInt(axis: AxisName): number {
  switch (axis) {
    case Axis.X:
      return 1;
    case Axis.Y:
      return 2;
    default:
      return 0;
  }
}

/**
 * Creates a plane that renders a 2D XY slice of volume atlas data.
 */
export default class Atlas2DSlice implements VolumeRenderImpl {
  private settings: VolumeRenderSettings;
  public volume: Volume;
  private geometry: PlaneGeometry;
  protected geometryMesh: Mesh<BufferGeometry, Material>;
  private geometryTransformNode: Group;
  private boxHelper: Box3Helper;
  private uniforms: ReturnType<typeof sliceShaderUniforms>;
  private channelData!: FusedChannelData;
  /** When false, `channelData` is shared from another renderer and must not be cleaned up by this instance. */
  private ownsChannelData = true;
  private sliceUpdateWaiting = false;
  /** The axis being sliced along: Z = XY view, X = YZ view, Y = XZ view. */
  private viewAxisValue: Axis = Axis.Z;
  /** When true, always request the full volume (all Z slices) even for viewAxis 0. */
  private requireFullVolume = false;

  /**
   * Creates a new Atlas2DSlice.
   * @param volume The volume that this renderer should render data from.
   * @param settings Optional settings object. If set, updates the renderer with
   * the given settings. Otherwise, uses the default VolumeRenderSettings.
   */
  constructor(volume: Volume, settings: VolumeRenderSettings = new VolumeRenderSettings(volume)) {
    this.volume = volume;
    this.uniforms = sliceShaderUniforms();
    [this.geometry, this.geometryMesh] = this.createGeometry(this.uniforms);

    this.boxHelper = new Box3Helper(
      new Box3(new Vector3(-0.5, -0.5, -0.5), new Vector3(0.5, 0.5, 0.5)),
      BOUNDING_BOX_DEFAULT_COLOR
    );
    this.boxHelper.updateMatrixWorld();
    this.boxHelper.visible = false;

    this.geometryTransformNode = new Group();
    this.geometryTransformNode.name = "VolumeContainerNode";

    this.geometryTransformNode.add(this.boxHelper, this.geometryMesh);

    this.setUniform("SLICE_INDEX", Math.floor(volume.imageInfo.volumeSize.z / 2));
    this.settings = settings;
    this.updateVolumeDimensions();
    this.updateSettings(settings, SettingsFlags.ALL);
  }

  /**
   * Syncs `this.settings.sliceIndex` with the corresponding shader uniform, or defers syncing until the slice is loaded.
   * For non-XY views, sliceIndex represents the coordinate along the slicing axis (X for YZ, Y for XZ).
   * @returns a boolean indicating whether the slice is out of bounds of the volume entirely.
   */
  private updateSlice(): boolean {
    const slice = Math.floor(this.settings.sliceIndex);
    const volSize = this.volume.imageInfo.volumeSize;

    // Determine the axis-appropriate size and subregion bounds
    let axisSize: number;
    let regionMin: number;
    let regionMax: number;
    switch (this.viewAxisValue) {
      case Axis.X: // YZ view: slicing along X
        axisSize = volSize.x;
        regionMin = this.volume.imageInfo.subregionOffset.x;
        regionMax = regionMin + this.volume.imageInfo.subregionSize.x;
        break;
      case Axis.Y: // XZ view: slicing along Y
        axisSize = volSize.y;
        regionMin = this.volume.imageInfo.subregionOffset.y;
        regionMax = regionMin + this.volume.imageInfo.subregionSize.y;
        break;
      default: // XY view: slicing along Z
        axisSize = volSize.z;
        regionMin = this.volume.imageInfo.subregionOffset.z;
        regionMax = regionMin + this.volume.imageInfo.subregionSize.z;
        break;
    }

    if (slice < 0 || slice >= axisSize) {
      return false;
    }

    if (slice < regionMin || slice >= regionMax) {
      // If the slice is outside the current loaded subregion, defer until the subregion is updated
      this.sliceUpdateWaiting = true;
    } else {
      this.setUniform("SLICE_INDEX", slice);
      this.sliceUpdateWaiting = false;
    }

    return true;
  }

  public updateVolumeDimensions(): void {
    const volumeScale = this.volume.normPhysicalSize.clone().multiply(this.settings.scale);
    const regionScale = volumeScale.clone().multiply(this.volume.normRegionSize);
    const volumeOffset = this.volume.getContentCenter().clone().multiply(this.settings.scale);

    // For non-XY views, remap scale/position so the face appears correctly in the XY plane.
    // The PlaneGeometry is always in XY, so we set mesh X/Y scale to the target face dimensions.
    switch (this.viewAxisValue) {
      case Axis.X: // YZ face: volume Z → mesh X, volume Y → mesh Y (Y vertical to align with XY)
        this.geometryMesh.position.set(volumeOffset.z, volumeOffset.y, 0);
        this.geometryMesh.scale.set(regionScale.z, regionScale.y, 1);
        break;
      case Axis.Y: // XZ face: volume X → mesh X, volume Z → mesh Y
        this.geometryMesh.position.set(volumeOffset.x, volumeOffset.z, 0);
        this.geometryMesh.scale.set(regionScale.x, regionScale.z, 1);
        break;
      default: // XY face (standard)
        this.geometryMesh.position.copy(volumeOffset);
        this.geometryMesh.scale.copy(regionScale);
        break;
    }

    this.setUniform("volumeScale", regionScale);
    this.boxHelper.box.set(volumeScale.clone().multiplyScalar(-0.5), volumeScale.clone().multiplyScalar(0.5));

    const { atlasTileDims, subregionSize, volumeSize } = this.volume.imageInfo;
    const atlasSize = new Vector2(subregionSize.x, subregionSize.y).multiply(atlasTileDims);

    // set lots of dimension uniforms
    this.setUniform("ATLAS_DIMS", atlasTileDims);
    this.setUniform("textureRes", atlasSize);
    this.setUniform("SLICES", volumeSize.z);
    this.setUniform("volumeSize", volumeSize);
    if (this.sliceUpdateWaiting) {
      this.updateSlice();
    }

    // (re)create channel data (skip if sharing from another renderer)
    if (this.ownsChannelData) {
      if (!this.channelData || this.channelData.width !== atlasSize.x || this.channelData.height !== atlasSize.y) {
        this.channelData?.cleanup();
        this.channelData = new FusedChannelData(atlasSize.x, atlasSize.y);
      }
    }
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
      if (this.settings.isOrtho && axis !== null) {
        const maxVal = this.settings.bounds.bmax[axis];
        const minVal = this.settings.bounds.bmin[axis];
        const thicknessPct = maxVal - minVal;
        this.setUniform("orthoThickness", thicknessPct);
      } else {
        this.setUniform("orthoThickness", 1.0);
      }
    }

    if (dirtyFlags & SettingsFlags.BOUNDING_BOX) {
      // Configure bounding box
      this.boxHelper.visible = this.settings.showBoundingBox;
      const colorVector = this.settings.boundingBoxColor;
      const newBoxColor = new Color(colorVector[0], colorVector[1], colorVector[2]);
      (this.boxHelper.material as LineBasicMaterial).color = newBoxColor;
    }

    if (dirtyFlags & SettingsFlags.TRANSFORM) {
      // Set rotation and translation
      this.geometryTransformNode.position.copy(this.settings.translation);
      this.geometryTransformNode.rotation.copy(this.settings.rotation);
      this.setUniform("flipVolume", this.settings.flipAxes);
    }

    if (dirtyFlags & SettingsFlags.MATERIAL) {
      this.setUniform("DENSITY", this.settings.density);
    }

    if (dirtyFlags & SettingsFlags.CAMERA) {
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

      const sliceInBounds = this.updateSlice();
      if (sliceInBounds) {
        if (this.viewAxisValue !== Axis.Z || this.requireFullVolume) {
          // For non-XY views (or triple-mode), we need the full volume loaded
          this.volume.updateRequiredData({
            subregion: new Box3(new Vector3(0, 0, 0), new Vector3(1, 1, 1)),
          });
        } else {
          const sliceLowerBound = Math.floor(this.settings.sliceIndex) / this.volume.imageInfo.volumeSize.z;
          const sliceUpperBound = (Math.floor(this.settings.sliceIndex) + 1) / this.volume.imageInfo.volumeSize.z;
          this.volume.updateRequiredData({
            subregion: new Box3(new Vector3(0, 0, sliceLowerBound), new Vector3(1, 1, sliceUpperBound)),
          });
        }
      }
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

  private createGeometry(
    uniforms: ReturnType<typeof sliceShaderUniforms>
  ): [PlaneGeometry, Mesh<BufferGeometry, Material>] {
    const geom = new PlaneGeometry(1.0, 1.0);
    const mesh: Mesh<BufferGeometry, Material> = new Mesh(geom);
    mesh.name = "Plane";

    // shader,vtx and frag.
    const vtxsrc = sliceVertexShaderSrc;
    const fgmtsrc = sliceFragmentShaderSrc;

    const threeMaterial = new ShaderMaterial({
      uniforms: uniforms,
      vertexShader: vtxsrc,
      fragmentShader: fgmtsrc,
      transparent: true,
      depthTest: true,
      depthWrite: false,
    });

    mesh.material = threeMaterial;
    return [geom, mesh];
  }

  public cleanup(): void {
    this.geometry.dispose();
    this.geometryMesh.material.dispose();

    if (this.ownsChannelData) {
      this.channelData?.cleanup();
    }
  }

  /** Returns the FusedChannelData owned by this renderer. */
  public getChannelData(): FusedChannelData {
    return this.channelData;
  }

  /**
   * Sets a shared FusedChannelData from another renderer.
   * When set, this renderer will not create or maintain its own fused data.
   */
  public setSharedChannelData(data: FusedChannelData): void {
    if (this.ownsChannelData && this.channelData) {
      this.channelData.cleanup();
    }
    this.channelData = data;
    this.ownsChannelData = false;
  }

  public viewpointMoved(): void {
    return;
  }

  public doRender(renderer: WebGLRenderer, camera: PerspectiveCamera | OrthographicCamera): void {
    if (!this.geometryMesh.visible) {
      return;
    }

    this.channelData.gpuFuse(renderer);
    this.setUniform("textureAtlas", this.channelData.getFusedTexture());
    this.setUniform("textureAtlasMask", this.channelData.maskTexture);

    this.geometryTransformNode.updateMatrixWorld(true);

    const mvm = new Matrix4();
    mvm.multiplyMatrices(camera.matrixWorldInverse, this.geometryMesh.matrixWorld);
    const mi = new Matrix4();
    mi.copy(mvm).invert();

    this.setUniform("inverseModelViewMatrix", mi);
  }

  public get3dObject(): Group {
    return this.geometryTransformNode;
  }

  // channelcolors is array of {rgbColor, lut} and channeldata is volume.channels
  public updateActiveChannels(channelcolors: FuseChannel[], channeldata: Channel[]): void {
    // Skip fusion if sharing another renderer's fused data
    if (!this.ownsChannelData) {
      return;
    }
    this.channelData.fuse(channelcolors, channeldata);

    // update to fused texture
    this.setUniform("textureAtlas", this.channelData.getFusedTexture());
    this.setUniform("textureAtlasMask", this.channelData.maskTexture);
  }

  private setUniform<U extends keyof ReturnType<typeof sliceShaderUniforms>>(
    name: U,
    value: ReturnType<typeof sliceShaderUniforms>[U]["value"]
  ) {
    if (!this.uniforms[name]) {
      return;
    }
    this.uniforms[name].value = value;
  }

  public setRenderUpdateListener(_listener?: ((iteration: number) => void) | undefined) {
    return;
  }

  /**
   * Sets the view axis for this slice renderer.
   * @param axis The axis to slice along: Axis.Z = XY view, Axis.X = YZ view, Axis.Y = XZ view.
   */
  public setViewAxis(axis: AxisName): void {
    if (this.viewAxisValue === axis) {
      return;
    }
    this.viewAxisValue = axis;
    this.setUniform("viewAxis", axisToShaderInt(axis));
    // The plane is created as an XY slice. Switching to X or Y must immediately
    // remap its dimensions to YZ or XZ, even when no later volume-size update occurs.
    this.updateVolumeDimensions();
  }

  /**
   * When set to true, this renderer will always request the full volume (all Z slices)
   * instead of only the single slice needed for XY view. Required for triple-slice mode
   * so that YZ/XZ renderers sharing this renderer's fused texture can sample all slices.
   */
  public setRequireFullVolume(require: boolean): void {
    this.requireFullVolume = require;
  }
}
