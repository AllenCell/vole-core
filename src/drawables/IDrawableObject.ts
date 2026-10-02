import { Group, Vector3, Euler } from "three";

import type { AxisName } from "../types.js";

export interface IDrawableObject {
  cleanup(): void;
  setVisible(visible: boolean): void;
  doRender(): void;
  get3dObject(): Group;
  setTranslation(translation: Vector3): void;
  setScale(scale: Vector3): void;
  /**
   * Optional. Should be called when parent transforms are updated.
   */
  onParentTransformUpdated?(): void;
  setRotation(eulerXYZ: Euler): void;
  setFlipAxes(flipX: number, flipY: number, flipZ: number): void;
  setOrthoThickness(thickness: number): void;
  setResolution(x: number, y: number): void;
  setAxisClip(axis: AxisName, minval: number, maxval: number, _isOrthoAxis: boolean): void;
  updateClipRegion(xmin: number, xmax: number, ymin: number, ymax: number, zmin: number, zmax: number): void;
}
