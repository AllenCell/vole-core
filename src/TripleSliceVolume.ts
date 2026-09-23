import {
  Box3,
  BufferGeometry,
  DepthTexture,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Texture,
  Vector3,
  WebGLRenderer,
} from "three";

import Atlas2DSlice, { SliceEdge } from "./Atlas2DSlice.js";
import Channel from "./Channel.js";
import { OVERLAY_LAYER } from "./ThreeJsPanel.js";
import Volume from "./Volume.js";
import type { AxisName, FuseChannel, TripleViewPanes } from "./types.js";
import { Axis } from "./types.js";
import type { VolumeRenderImpl, TripleSliceSource } from "./VolumeRenderImpl.js";
import { SettingsFlags, VolumeRenderSettings } from "./VolumeRenderSettings.js";
import { clampSliceIndex } from "./utils/num_utils.js";
import { computeTripleLayout, computeTripleViewPanes } from "./utils/tripleSliceLayout.js";

/**
 * A VolumeRenderImpl that manages three Atlas2DSlice renderers (XY, YZ, XZ)
 * for triple-slice mode. All three share the XY renderer's fused channel data
 * so only one GPU texture fusion is needed.
 */
export default class TripleSliceVolume implements VolumeRenderImpl, TripleSliceSource {
  private renderers: [Atlas2DSlice, Atlas2DSlice, Atlas2DSlice];
  private group: Group;
  private volume: Volume;
  private baseSettings: VolumeRenderSettings;

  // Crosshair lines: 2 per pane (vertical + horizontal), plus a darker "drop shadow"
  // line offset by a fixed number of screen pixels below/right of each one.
  private crosshairMaterial: LineBasicMaterial;
  private crosshairShadowMaterial: LineBasicMaterial;
  private crosshairLines: [Line, Line, Line, Line, Line, Line]; // [xyV, xyH, yzV, yzH, xzV, xzH]
  private crosshairShadowLines: [Line, Line, Line, Line, Line, Line];

  // Updated by updateLayout(); used to convert CROSSHAIR_SHADOW_OFFSET_PIXELS into the
  // unscaled physical-size units that crosshair line endpoints are expressed in.
  private pixelsPerWorldUnit = 0;
  private fitScale = 1;

  /**
   * Triple view has a fixed, screen-aligned pane layout. Preserve axis flips,
   * but do not let the volume alignment transform affect the panes.
   */
  private static getProjectionSettings(settings: VolumeRenderSettings): VolumeRenderSettings {
    const projectionSettings = settings.clone();
    projectionSettings.translation.set(0, 0, 0);
    projectionSettings.rotation.set(0, 0, 0);
    projectionSettings.scale.set(1, 1, 1);
    return projectionSettings;
  }

  constructor(volume: Volume, settings: VolumeRenderSettings) {
    this.volume = volume;
    this.baseSettings = settings;

    const projectionSettings = TripleSliceVolume.getProjectionSettings(settings);

    const xySlice = new Atlas2DSlice(volume, projectionSettings.clone());
    xySlice.setViewAxis(Axis.Z);
    xySlice.setRequireFullVolume(true);

    const yzSlice = new Atlas2DSlice(volume, projectionSettings.clone());
    yzSlice.setViewAxis(Axis.X);

    const xzSlice = new Atlas2DSlice(volume, projectionSettings.clone());
    xzSlice.setViewAxis(Axis.Y);

    // Tick marks are drawn only on each pane's external edges, so that they don't
    // reach into the gap between neighboring panes. See the updateLayout diagram.
    xySlice.setTickMarkEdges(SliceEdge.BOTTOM | SliceEdge.LEFT);
    yzSlice.setTickMarkEdges(SliceEdge.BOTTOM | SliceEdge.TOP | SliceEdge.RIGHT);
    xzSlice.setTickMarkEdges(SliceEdge.TOP | SliceEdge.LEFT | SliceEdge.RIGHT);

    this.renderers = [xySlice, yzSlice, xzSlice];

    // Share the XY renderer's fused texture atlas with YZ and XZ renderers
    yzSlice.setSharedChannelData(xySlice.getChannelData());
    xzSlice.setSharedChannelData(xySlice.getChannelData());

    // Parent group so get3dObject() returns a single Object3D containing all 3
    this.group = new Group();
    this.group.add(xySlice.get3dObject());
    this.group.add(yzSlice.get3dObject());
    this.group.add(xzSlice.get3dObject());

    // Request full volume data for YZ/XZ slicing
    volume.updateRequiredData({ subregion: new Box3(new Vector3(0, 0, 0), new Vector3(1, 1, 1)) });

    // Create crosshair overlay lines (2 per pane, on OVERLAY_LAYER), plus a darker
    // shadow line behind each one for a subtle drop-shadow effect.
    this.crosshairMaterial = new LineBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false });
    this.crosshairShadowMaterial = new LineBasicMaterial({
      color: TripleSliceVolume.CROSSHAIR_SHADOW_COLOR,
      depthTest: false,
      depthWrite: false,
    });
    this.crosshairShadowLines = [
      this.createCrosshairLine(this.crosshairShadowMaterial, 0),
      this.createCrosshairLine(this.crosshairShadowMaterial, 0),
      this.createCrosshairLine(this.crosshairShadowMaterial, 0),
      this.createCrosshairLine(this.crosshairShadowMaterial, 0),
      this.createCrosshairLine(this.crosshairShadowMaterial, 0),
      this.createCrosshairLine(this.crosshairShadowMaterial, 0),
    ];
    this.crosshairLines = [
      this.createCrosshairLine(this.crosshairMaterial, 1),
      this.createCrosshairLine(this.crosshairMaterial, 1),
      this.createCrosshairLine(this.crosshairMaterial, 1),
      this.createCrosshairLine(this.crosshairMaterial, 1),
      this.createCrosshairLine(this.crosshairMaterial, 1),
      this.createCrosshairLine(this.crosshairMaterial, 1),
    ];
    // Add each pane's shadow lines before its main lines so the main lines draw on top.
    this.renderers[0]
      .get3dObject()
      .add(this.crosshairShadowLines[0], this.crosshairShadowLines[1], this.crosshairLines[0], this.crosshairLines[1]);
    this.renderers[1]
      .get3dObject()
      .add(this.crosshairShadowLines[2], this.crosshairShadowLines[3], this.crosshairLines[2], this.crosshairLines[3]);
    this.renderers[2]
      .get3dObject()
      .add(this.crosshairShadowLines[4], this.crosshairShadowLines[5], this.crosshairLines[4], this.crosshairLines[5]);

    // Apply initial slice indices to renderers
    this.applyAllSliceIndices();
    this.updateCrosshairs();
  }

  // --- VolumeRenderImpl interface ---

  updateSettings(settings: VolumeRenderSettings, dirtyFlags?: number | SettingsFlags): void {
    // Track the latest settings reference so bounds appearance stays in sync.
    this.baseSettings = settings;
    if (dirtyFlags !== undefined && dirtyFlags & SettingsFlags.ROI) {
      // Apply per-axis slice indices to each renderer
      this.applyAllSliceIndices();
    }
    // Forward non-ROI flags to all renderers
    const nonRoiFlags = dirtyFlags !== undefined ? dirtyFlags & ~SettingsFlags.ROI : dirtyFlags;
    if (nonRoiFlags === undefined || nonRoiFlags !== 0) {
      const projectionSettings = TripleSliceVolume.getProjectionSettings(settings);
      for (const r of this.renderers) {
        r.updateSettings(projectionSettings, nonRoiFlags);
      }
    }
    // Recompute layout when resolution or view parameters change. A transform
    // update also touches each slice renderer's root node, which is where the
    // fixed pane position lives, so restore the pane layout afterward.
    if (
      dirtyFlags === undefined ||
      dirtyFlags & (SettingsFlags.SAMPLING | SettingsFlags.VIEW | SettingsFlags.TRANSFORM)
    ) {
      this.updateCrosshairs();
      this.updateLayout();
    }
  }

  get3dObject(): Object3D {
    return this.group;
  }

  doRender(
    renderer: WebGLRenderer,
    camera: PerspectiveCamera | OrthographicCamera,
    _depthTexture?: DepthTexture | Texture | null
  ): void {
    // Render all three slices; they are positioned in world space by updateLayout
    for (let i = 0; i < 3; i++) {
      this.renderers[i].get3dObject().visible = true;
      this.renderers[i].doRender(renderer, camera);
    }
  }

  updateVolumeDimensions(): void {
    for (const r of this.renderers) {
      r.updateVolumeDimensions();
    }
    // Re-share channel data in case the primary's was recreated
    this.renderers[1].setSharedChannelData(this.renderers[0].getChannelData());
    this.renderers[2].setSharedChannelData(this.renderers[0].getChannelData());

    // Clamp indices to current volume bounds (resolution may differ across mode switches)
    const volSize = this.volume.imageInfo.volumeSize;
    const indices = this.baseSettings.tripleSliceIndices;
    indices.x = clampSliceIndex(indices.x, volSize.x);
    indices.y = clampSliceIndex(indices.y, volSize.y);
    indices.z = clampSliceIndex(indices.z, volSize.z);

    this.applyAllSliceIndices();
    this.updateCrosshairs();
    this.updateLayout();
  }

  cleanup(): void {
    // Dispose crosshair resources
    this.crosshairMaterial.dispose();
    this.crosshairShadowMaterial.dispose();
    for (const line of this.crosshairLines) {
      line.geometry.dispose();
    }
    for (const line of this.crosshairShadowLines) {
      line.geometry.dispose();
    }
    // Clean up non-primary renderers first (they share primary's channel data)
    this.renderers[1].cleanup();
    this.renderers[2].cleanup();
    // Then clean up primary (owns the fused channel data)
    this.renderers[0].cleanup();
  }

  viewpointMoved(): void {
    // No-op for slice rendering
  }

  setRenderUpdateListener(_listener?: (iteration: number) => void): void {
    // No-op: triple slice doesn't do progressive rendering
  }

  updateActiveChannels(channelcolors: FuseChannel[], channeldata: Channel[]): void {
    // Only fuse on the XY (primary) renderer; YZ/XZ share its texture
    this.renderers[0].updateActiveChannels(channelcolors, channeldata);
  }

  // --- Triple-slice-specific methods ---

  /**
   * Applies one axis's slice index to its corresponding renderer.
   * XY renderer (index 0) slices along Z, YZ (index 1) along X, XZ (index 2) along Y.
   */
  private applySliceToRenderer(axis: AxisName): void {
    const index = this.baseSettings.tripleSliceIndices[axis];
    const rendererIndex = axis === "z" ? 0 : axis === "x" ? 1 : 2;
    const settings = TripleSliceVolume.getProjectionSettings(this.baseSettings);
    settings.sliceIndex = index;
    this.renderers[rendererIndex].updateSettings(settings, SettingsFlags.ROI);
  }

  /** Applies all three axis slice indices to their renderers. */
  private applyAllSliceIndices(): void {
    this.applySliceToRenderer(Axis.X);
    this.applySliceToRenderer(Axis.Y);
    this.applySliceToRenderer(Axis.Z);
  }

  /** Returns a copy of the current per-axis slice indices, to prevent external mutation of internal state. */
  getIndices(): Vector3 {
    return this.baseSettings.tripleSliceIndices.clone();
  }

  /** Returns the volume dimensions in voxels. */
  getVolumeSize(): Vector3 {
    return this.volume.imageInfo.volumeSize;
  }

  /** Returns the normalized physical size of the volume. */
  getPhysicalSize(): Vector3 {
    return this.volume.normPhysicalSize;
  }

  /**
   * Sets the slice index for a given axis, clamping to valid range.
   * Updates the corresponding internal renderer.
   */
  setSliceIndex(axis: AxisName, index: number): void {
    const volSize = this.volume.imageInfo.volumeSize;
    this.baseSettings.tripleSliceIndices[axis] = clampSliceIndex(index, volSize[axis]);
    this.applySliceToRenderer(axis);
    this.updateCrosshairs();
  }

  /** Updates crosshair line positions based on current indices, volume size, and physical size. */
  updateCrosshairs(): void {
    const indices = this.baseSettings.tripleSliceIndices;
    const volumeSize = this.volume.imageInfo.volumeSize;
    const phys = this.volume.normPhysicalSize;

    const nx = volumeSize.x > 1 ? (indices.x / (volumeSize.x - 1) - 0.5) * phys.x : 0;
    const ny = volumeSize.y > 1 ? (indices.y / (volumeSize.y - 1) - 0.5) * phys.y : 0;
    const nz = volumeSize.z > 1 ? (indices.z / (volumeSize.z - 1) - 0.5) * phys.z : 0;

    const halfPx = phys.x * 0.5;
    const halfPy = phys.y * 0.5;
    const halfPz = phys.z * 0.5;

    // Shadow lines sit a fixed number of screen pixels right of the vertical line /
    // below the horizontal line, regardless of current zoom.
    const shadow = this.getCrosshairShadowOffset();

    const [xyV, xyH, yzV, yzH, xzV, xzH] = this.crosshairLines;
    const [xyVs, xyHs, yzVs, yzHs, xzVs, xzHs] = this.crosshairShadowLines;

    // XY pane: vertical at x=nx spanning Y, horizontal at y=ny spanning X
    this.setCrosshairEndpoints(xyV, [nx, -halfPy, 0], [nx, halfPy, 0]);
    this.setCrosshairEndpoints(xyH, [-halfPx, ny, 0], [halfPx, ny, 0]);
    this.setCrosshairEndpoints(xyVs, [nx + shadow, -halfPy, 0], [nx + shadow, halfPy, 0]);
    this.setCrosshairEndpoints(xyHs, [-halfPx, ny - shadow, 0], [halfPx, ny - shadow, 0]);

    // YZ pane: vertical at display X=nz spanning Y, horizontal at y=ny spanning Z
    this.setCrosshairEndpoints(yzV, [nz, -halfPy, 0], [nz, halfPy, 0]);
    this.setCrosshairEndpoints(yzH, [-halfPz, ny, 0], [halfPz, ny, 0]);
    this.setCrosshairEndpoints(yzVs, [nz + shadow, -halfPy, 0], [nz + shadow, halfPy, 0]);
    this.setCrosshairEndpoints(yzHs, [-halfPz, ny - shadow, 0], [halfPz, ny - shadow, 0]);

    // XZ pane: vertical at display X=nx spanning Z, horizontal at y=nz spanning X
    this.setCrosshairEndpoints(xzV, [nx, -halfPz, 0], [nx, halfPz, 0]);
    this.setCrosshairEndpoints(xzH, [-halfPx, nz, 0], [halfPx, nz, 0]);
    this.setCrosshairEndpoints(xzVs, [nx + shadow, -halfPz, 0], [nx + shadow, halfPz, 0]);
    this.setCrosshairEndpoints(xzHs, [-halfPx, nz - shadow, 0], [halfPx, nz - shadow, 0]);
  }

  /** Converts a fixed screen-pixel offset into the unscaled physical-size units used above. */
  private getCrosshairShadowOffset(): number {
    if (this.pixelsPerWorldUnit <= 0 || this.fitScale <= 0) {
      return 0;
    }
    return TripleSliceVolume.CROSSHAIR_SHADOW_OFFSET_PIXELS / (this.pixelsPerWorldUnit * this.fitScale);
  }

  private createCrosshairLine(material: LineBasicMaterial, renderOrder: number): Line {
    const geom = new BufferGeometry();
    geom.setAttribute("position", new Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
    const line = new Line(geom, material);
    line.layers.set(OVERLAY_LAYER);
    line.frustumCulled = false;
    line.renderOrder = renderOrder;
    return line;
  }

  private setCrosshairEndpoints(line: Line, p1: [number, number, number], p2: [number, number, number]): void {
    const posAttr = line.geometry.getAttribute("position");
    posAttr.setXYZ(0, p1[0], p1[1], p1[2]);
    posAttr.setXYZ(1, p2[0], p2[1], p2[2]);
    posAttr.needsUpdate = true;
  }

  /** Gap between panes in CSS pixels. */
  private static readonly TRIPLE_VIEW_GAP = 2;

  /** Offset of each crosshair's drop-shadow line, in screen pixels. */
  private static readonly CROSSHAIR_SHADOW_OFFSET_PIXELS = 1;

  /** Color of the crosshair drop-shadow lines (a dark, but not pure black, gray). */
  private static readonly CROSSHAIR_SHADOW_COLOR = 0x333333;

  /**
   * Recomputes the layout of the three slice panes to fit within the current camera frustum.
   * Uses `baseSettings.resolution` and `baseSettings.orthoScale` to derive the frustum,
   * then scales and positions all three slice groups accordingly.
   *
   * Layout (bottom-left origin):
   *  +--------+--------+
   *  |   XZ   |        |
   *  +--------+--------+
   *  |   XY   |   YZ   |
   *  +--------+--------+
   */
  private updateLayout(): void {
    const { resolution, orthoScale } = this.baseSettings;
    if (resolution.x === 0 || resolution.y === 0) {
      return;
    }

    const frustumHeight = 2 * orthoScale;
    const frustumWidth = frustumHeight * (resolution.x / resolution.y);

    const pixelsPerWorldUnit = resolution.y / frustumHeight;
    const gapWorld = pixelsPerWorldUnit > 0 ? TripleSliceVolume.TRIPLE_VIEW_GAP / pixelsPerWorldUnit : 0;

    const layout = computeTripleLayout(this.volume.normPhysicalSize, frustumWidth, frustumHeight, gapWorld);
    if (!layout) {
      return;
    }
    const { fitScale, px, py, pz } = layout;
    this.pixelsPerWorldUnit = pixelsPerWorldUnit;
    this.fitScale = fitScale;

    // Apply uniform scale to the parent group
    this.group.scale.set(fitScale, fitScale, 1);

    // Layout in unscaled physical coords (group.scale handles the fitting)
    const gapUnscaled = gapWorld / fitScale;
    const totalW = px + gapUnscaled + pz;
    const totalH = py + gapUnscaled + pz;

    // XY pane (bottom-left)
    const xyX = -totalW / 2 + px / 2;
    const xyY = -totalH / 2 + py / 2;
    this.renderers[0].get3dObject().position.set(xyX, xyY, 0);

    // YZ pane (bottom-right)
    const yzX = totalW / 2 - pz / 2;
    const yzY = -totalH / 2 + py / 2;
    this.renderers[1].get3dObject().position.set(yzX, yzY, 0);

    // XZ pane (top-left)
    const xzX = -totalW / 2 + px / 2;
    const xzY = totalH / 2 - pz / 2;
    this.renderers[2].get3dObject().position.set(xzX, xzY, 0);

    // Tick marks are sized in screen pixels, so each renderer needs the layout scale.
    for (const r of this.renderers) {
      r.setParentScale(fitScale);
    }
    this.updateCrosshairs();
  }

  /**
   * Computes the per-pane rectangles for triple-slice view in CSS pixels (bottom-left origin).
   * @param canvasW Canvas width in CSS pixels
   * @param canvasH Canvas height in CSS pixels
   */
  getTripleViewPanesCSS(canvasW: number, canvasH: number): TripleViewPanes {
    return computeTripleViewPanes(this.volume.normPhysicalSize, canvasW, canvasH, TripleSliceVolume.TRIPLE_VIEW_GAP);
  }
}
