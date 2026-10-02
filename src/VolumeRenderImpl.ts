import { DepthTexture, Object3D, OrthographicCamera, PerspectiveCamera, Texture, Vector3, WebGLRenderer } from "three";

import { SettingsFlags, VolumeRenderSettings } from "./VolumeRenderSettings.js";
import type { AxisName, FuseChannel, TripleViewPanes } from "./types.js";
import Channel from "./Channel.js";

/**
 * Interface for objects that can provide triple-slice data and handle interaction.
 * Implemented by TripleSliceVolume so ThreeJsPanel can interact with it directly
 * without callback indirection.
 */
export interface TripleSliceSource {
  getIndices(): Vector3;
  getVolumeSize(): Vector3;
  getPhysicalSize(): Vector3;
  setSliceIndex(axis: AxisName, index: number): void;
  /** Computes per-pane rectangles in CSS pixels (bottom-left origin). */
  getTripleViewPanesCSS(canvasW: number, canvasH: number): TripleViewPanes;
}

export interface VolumeRenderImpl {
  /**
   * Applies the given VolumeRenderSettings to this volume renderer.
   * @param settings a VolumeRenderSettings object to update values from.
   * @param dirtyFlags bitwise flag used to mark groups of changed settings in the
   * provided `settings` object.
   * If unset, forces recompute of all settings-based renderer configuration.
   * See the `SettingsFlags` enum for recognized values.
   */
  updateSettings: (settings: VolumeRenderSettings, dirtyFlags?: number | SettingsFlags) => void;

  get3dObject: () => Object3D;
  doRender: (
    renderer: WebGLRenderer,
    camera: PerspectiveCamera | OrthographicCamera,
    depthTexture?: DepthTexture | Texture | null
  ) => void;
  updateVolumeDimensions: () => void;
  cleanup: () => void;
  viewpointMoved: () => void;
  setRenderUpdateListener: (_listener?: (iteration: number) => void) => void;
  updateActiveChannels: (channelcolors: FuseChannel[], channeldata: Channel[]) => void;
}
