import { Euler, Group, Material, Mesh, Vector3 } from "three";

import type { AxisName } from "../types.js";
import { IDrawableObject } from "./IDrawableObject.js";

/**
 * Abstract base class for drawable 3D mesh objects.
 *
 * Provides default implementations for some methods in the IDrawableObject
 * interface, including handling for visibility, transformations, and cleanup.
 *
 * As a default, subclasses should call `this.addChildMesh(mesh)` to register
 * any meshes that should be managed by the base class.
 */
export default abstract class BaseDrawableMeshObject implements IDrawableObject {
  /**
   * Pivot group that all child meshes are parented to. Transformations are
   * applied to this group.
   */
  protected readonly meshPivot: Group;
  protected scale: Vector3;
  protected flipAxes: Vector3;

  constructor() {
    this.meshPivot = new Group();
    this.scale = new Vector3(1, 1, 1);
    this.flipAxes = new Vector3(1, 1, 1);
  }

  protected addChildMesh(mesh: Mesh): void {
    this.meshPivot.add(mesh);
  }

  protected removeChildMesh(mesh: Mesh): void {
    this.meshPivot.remove(mesh);
  }

  cleanup(): void {
    this.meshPivot.traverse((obj) => {
      if (obj instanceof Mesh) {
        obj.geometry.dispose();
        (obj.material as Material).dispose();
      }
    });
    this.meshPivot.clear();
  }

  doRender(): void {
    // no op
  }

  setVisible(visible: boolean): void {
    this.meshPivot.visible = visible;
  }

  get3dObject(): Group {
    return this.meshPivot;
  }

  setTranslation(translation: Vector3): void {
    this.meshPivot.position.copy(translation);
  }

  setScale(scale: Vector3): void {
    this.scale.copy(scale);
    this.meshPivot.scale.copy(scale).multiply(this.flipAxes);
  }

  setRotation(eulerXYZ: Euler): void {
    this.meshPivot.rotation.copy(eulerXYZ);
  }

  setFlipAxes(flipX: number, flipY: number, flipZ: number): void {
    this.flipAxes.set(flipX, flipY, flipZ);
    this.meshPivot.scale.copy(this.scale).multiply(this.flipAxes);
  }

  setOrthoThickness(_thickness: number): void {
    // no op
  }

  setResolution(_x: number, _y: number): void {
    // no op
  }

  setAxisClip(_axis: AxisName, _minval: number, _maxval: number, _isOrthoAxis: boolean): void {
    // no op
  }

  updateClipRegion(_xmin: number, _xmax: number, _ymin: number, _ymax: number, _zmin: number, _zmax: number): void {
    // no op
  }
}
