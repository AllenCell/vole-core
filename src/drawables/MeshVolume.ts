import {
  BufferGeometry,
  Euler,
  Object3D,
  Vector3,
  Color,
  Mesh,
  Group,
  Material,
  MeshPhongMaterial,
  Plane,
  DoubleSide,
} from "three";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";

import { defaultMaterialSettings } from "../constants/materials.js";

import FileSaver from "../FileSaver.js";
import NaiveSurfaceNets from "../NaiveSurfaceNets.js";
import MarchingCubes from "../MarchingCubes.js";
import Volume from "../Volume.js";
import type { Bounds, AxisName } from "../types.js";
import type { IDrawableObject } from "./IDrawableObject.js";
import { MESH_LAYER } from "../ThreeJsPanel.js";

/**
 * this cutoff is chosen to have a small buffer of values before the object is treated
 * as transparent for gpu blending and depth testing.
 */
const ALPHA_THRESHOLD = 0.95;

export default class MeshVolume implements IDrawableObject {
  private volume: Volume;
  private meshRoot: Object3D;
  private meshPivot: Group;
  private meshrep: (Group | null)[];
  private channelColors: [number, number, number][];
  private channelOpacities: number[];
  private bounds: Bounds;
  private scale: Vector3;

  constructor(volume: Volume) {
    // need?
    this.volume = volume;

    this.meshRoot = new Object3D(); //create an empty container
    this.meshRoot.name = "Mesh Surface Group";

    // compensating for generated isosurface vertex coordinates
    // arguably this could be set on meshPivot
    this.meshRoot.scale.setScalar(0.5);

    // handle transform ordering for giving the meshroot a rotation about a pivot point
    this.meshPivot = new Group();
    this.meshPivot.name = "MeshContainerNode";
    this.meshPivot.add(this.meshRoot);

    this.meshrep = [];

    this.channelColors = [];
    this.channelOpacities = [];

    this.scale = new Vector3(1, 1, 1);
    this.bounds = {
      bmin: new Vector3(-0.5, -0.5, -0.5),
      bmax: new Vector3(0.5, 0.5, 0.5),
    };
  }

  cleanup(): void {
    for (let i = 0; i < this.volume.imageInfo.numChannels; ++i) {
      this.destroyIsosurface(i);
    }
  }

  setVisible(isVisible: boolean): void {
    this.meshRoot.visible = isVisible;
  }

  doRender(): void {
    // no op
  }

  get3dObject(): Group {
    return this.meshPivot;
  }

  setScale(scale: Vector3, position = new Vector3(0, 0, 0)): void {
    this.scale = scale;

    this.meshRoot.scale.copy(scale).multiplyScalar(0.5);
    this.meshRoot.position.copy(position);
  }

  setFlipAxes(flipX: number, flipY: number, flipZ: number): void {
    this.meshRoot.scale.copy(
      new Vector3(0.5 * this.scale.x * flipX, 0.5 * this.scale.y * flipY, 0.5 * this.scale.z * flipZ)
    );
  }

  setTranslation(vec3xyz: Vector3): void {
    this.meshPivot.position.copy(vec3xyz);
  }

  setRotation(eulerXYZ: Euler): void {
    this.meshPivot.rotation.copy(eulerXYZ);
    this.updateClipFromBounds();
  }

  setResolution(_x: number, _y: number): void {
    // no op
  }

  setOrthoThickness(_value: number): void {
    // no op
  }

  setAxisClip(axis: AxisName, minval: number, maxval: number, _isOrthoAxis: boolean): void {
    this.bounds.bmax[axis] = maxval;
    this.bounds.bmin[axis] = minval;
    this.updateClipFromBounds();
  }

  //////////////////////////////

  updateMeshColors(channelColors: [number, number, number][]): void {
    // stash values here for later changes
    this.channelColors = channelColors;

    // update existing meshes
    for (let i = 0; i < this.volume.imageInfo.numChannels; ++i) {
      const meshrep = this.meshrep[i];
      if (meshrep) {
        const rgb = channelColors[i];
        const c = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];

        meshrep.traverse(function (child) {
          if (child instanceof Mesh) {
            child.material.color = new Color(c);
          }
        });
      }
    }
  }

  createMaterialForChannel(rgb: [number, number, number], alpha: number, _transp: boolean): Material {
    const col = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
    const material = new MeshPhongMaterial({
      color: new Color(col),
      shininess: defaultMaterialSettings.shininess,
      specular: new Color(defaultMaterialSettings.specularColor),
      opacity: alpha,
      transparent: alpha < ALPHA_THRESHOLD,
      side: DoubleSide,
    });
    return material;
  }

  createMeshForChannel(
    channelIndex: number,
    colorrgb: [number, number, number],
    isovalue: number,
    alpha: number,
    transp: boolean
  ): Group {
    // note that if isovalue out of range, this will return an empty array.
    const geometries = this.generateIsosurfaceGeometry(channelIndex, isovalue);
    const material = this.createMaterialForChannel(colorrgb, alpha, transp);

    const theObject = new Group();
    theObject.name = "Channel" + channelIndex;
    theObject.userData = { isovalue: isovalue };
    // proper scaling will be done in parent object
    for (let i = 0; i < geometries.length; ++i) {
      const mesh = new Mesh(geometries[i], material);
      mesh.layers.set(MESH_LAYER);
      theObject.add(mesh);
    }
    return theObject;
  }

  updateIsovalue(channel: number, value: number): void {
    const meshrep = this.meshrep[channel];
    if (!meshrep) {
      return;
    }
    if (meshrep.userData.isovalue === value) {
      return;
    }

    // find the current isosurface opacity and color.
    const opacity = this.channelOpacities[channel];
    const color = this.channelColors[channel];

    this.destroyIsosurface(channel);
    const newmeshrep = this.createMeshForChannel(channel, color, value, opacity, false);
    this.meshrep[channel] = newmeshrep;

    this.meshRoot.add(newmeshrep);
  }

  getIsovalue(channel: number): number | undefined {
    const meshrep = this.meshrep[channel];
    return meshrep?.userData.isovalue;
  }

  getOpacity(channel: number): number | undefined {
    const meshrep = this.meshrep[channel];
    let opacity: number | undefined = undefined;

    meshrep?.traverse((obj) => {
      if (obj instanceof Mesh) {
        opacity = obj.material.opacity;
      }
    });

    return opacity;
  }

  updateClipRegion(xmin: number, xmax: number, ymin: number, ymax: number, zmin: number, zmax: number): void {
    // incoming values expected to be between 0 and 1.
    // I shift them here to be between -0.5 and 0.5
    this.bounds = {
      bmin: new Vector3(xmin - 0.5, ymin - 0.5, zmin - 0.5),
      bmax: new Vector3(xmax - 0.5, ymax - 0.5, zmax - 0.5),
    };
    this.updateClipFromBounds();
  }

  updateClipFromBounds(): void {
    const xmin = this.bounds.bmin.x;
    const ymin = this.bounds.bmin.y;
    const zmin = this.bounds.bmin.z;
    const xmax = this.bounds.bmax.x;
    const ymax = this.bounds.bmax.y;
    const zmax = this.bounds.bmax.z;

    const euler = this.meshPivot.rotation;

    for (let channel = 0; channel < this.meshrep.length; ++channel) {
      const meshrep = this.meshrep[channel];
      if (!meshrep) {
        continue;
      }
      const planes: Plane[] = [];
      // up to 6 planes.
      if (xmin > -0.5) {
        planes.push(new Plane(new Vector3(1, 0, 0).applyEuler(euler), this.meshRoot.position.x + -xmin * this.scale.x));
      }
      if (ymin > -0.5) {
        planes.push(new Plane(new Vector3(0, 1, 0).applyEuler(euler), this.meshRoot.position.y + -ymin * this.scale.y));
      }
      if (zmin > -0.5) {
        planes.push(new Plane(new Vector3(0, 0, 1).applyEuler(euler), this.meshRoot.position.z + -zmin * this.scale.z));
      }
      if (xmax < 0.5) {
        planes.push(new Plane(new Vector3(-1, 0, 0).applyEuler(euler), this.meshRoot.position.x + xmax * this.scale.x));
      }
      if (ymax < 0.5) {
        planes.push(new Plane(new Vector3(0, -1, 0).applyEuler(euler), this.meshRoot.position.y + ymax * this.scale.y));
      }
      if (zmax < 0.5) {
        planes.push(new Plane(new Vector3(0, 0, -1).applyEuler(euler), this.meshRoot.position.z + zmax * this.scale.z));
      }
      meshrep.traverse(function (child) {
        if (child instanceof Mesh) {
          child.material.clippingPlanes = planes;
        }
      });
    }
  }

  updateOpacity(channel: number, value: number): void {
    this.channelOpacities[channel] = value;
    const meshrep = this.meshrep[channel];
    if (!meshrep) {
      return;
    }

    meshrep.traverse(function (child) {
      if (child instanceof Mesh) {
        child.material.opacity = value;
        child.material.transparent = value < ALPHA_THRESHOLD;
        //child.material.depthWrite = !child.material.transparent;
      }
    });
  }

  hasIsosurface(channel: number): boolean {
    return !!this.meshrep[channel];
  }

  createIsosurface(
    channel: number,
    color: [number, number, number],
    // 127 is half of the intensity range 0..255
    value = 127,
    // 1.0 indicates full opacity, non-transparent
    alpha = 1.0,
    transp = alpha < ALPHA_THRESHOLD
  ): void {
    if (!this.meshrep[channel]) {
      const meshrep = this.createMeshForChannel(channel, color, value, alpha, transp);
      this.meshrep[channel] = meshrep;
      this.channelOpacities[channel] = alpha;
      this.channelColors[channel] = color;
      // note we are not removing any prior mesh reps for this channel
      this.meshRoot.add(meshrep);
    }
  }

  destroyIsosurface(channel: number): void {
    const meshrep = this.meshrep[channel];
    if (meshrep) {
      this.meshRoot.remove(meshrep);
      meshrep.traverse(function (child) {
        if (child instanceof Mesh) {
          child.material.dispose();
          child.geometry.dispose();
        }
      });
      this.meshrep[channel] = null;
    }
  }

  saveChannelIsosurface(channelIndex: number, type: string, name?: string): void {
    const meshrep = this.meshrep[channelIndex];
    if (!meshrep) {
      return;
    }

    const namePrefix = name !== undefined ? `${name}_` : "";

    if (type === "STL") {
      this.exportSTL(meshrep, namePrefix + "_" + this.volume.channelNames[channelIndex]);
    } else if (type === "GLTF") {
      // temporarily set other meshreps to invisible
      const prevviz: boolean[] = [];
      for (let i = 0; i < this.meshrep.length; ++i) {
        const meshrepi = this.meshrep[i];
        if (meshrepi) {
          prevviz[i] = meshrepi.visible;
          meshrepi.visible = i === channelIndex;
        }
      }
      this.exportGLTF(this.meshRoot, namePrefix + "_" + this.volume.channelNames[channelIndex]);
      for (let i = 0; i < this.meshrep.length; ++i) {
        const meshrepi = this.meshrep[i];
        if (meshrepi) {
          meshrepi.visible = prevviz[i];
        }
      }
    }
  }

  exportSTL(input: Object3D, fname: string): void {
    const ex = new STLExporter();
    const output = ex.parse(input, { binary: true });
    // STLExporter's typing shows that it returns string
    // but this is not the case when binary=true.
    FileSaver.saveBinary(output.buffer, fname + ".stl");
  }

  // takes a scene or object or array of scenes or objects or both!
  exportGLTF(input: Object3D, fname: string): void {
    const gltfExporter = new GLTFExporter();
    const options = {
      // transforms as translate rotate scale?
      trs: false,
      onlyVisible: true,
      truncateDrawRange: true,
      binary: true,
      forceIndices: false,
      forcePowerOfTwoTextures: true,
    };
    gltfExporter.parse(
      input,
      function (result) {
        if (result instanceof ArrayBuffer) {
          FileSaver.saveArrayBuffer(result, fname + ".glb");
        } else {
          const output = JSON.stringify(result, null, 2);
          FileSaver.saveString(output, fname + ".gltf");
        }
      },
      function (error) {
        console.error(error);
      },
      options
    );
  }

  generateIsosurfaceGeometry(channelIndex: number, isovalue: number): BufferGeometry[] {
    if (!this.volume) {
      return [];
    }
    const volumeData = this.volume.channels[channelIndex].volumeData;

    const marchingcubes = true;
    const regionSizeArr = this.volume.imageInfo.subregionSize.toArray();

    if (marchingcubes) {
      const effect = new MarchingCubes(regionSizeArr, new Material(), false, false, true, volumeData);
      effect.position.copy(this.meshRoot.position);
      effect.scale.set(0.5 * this.scale.x, 0.5 * this.scale.y, 0.5 * this.scale.z);
      effect.isovalue = isovalue;
      const geometries = effect.generateGeometry();
      // TODO: weld vertices and recompute normals if MarchingCubes results in excessive coincident verts
      // for (var i = 0; i < geometries.length; ++i) {
      //   var g = new THREE.Geometry().fromBufferGeometry(geometries[i]);
      //   g.mergeVertices();
      //   geometries[i] = new THREE.BufferGeometry().fromGeometry(g);
      //   geometries[i].computeVertexNormals();
      // }
      return geometries || [];
    } else {
      const result = NaiveSurfaceNets.surfaceNets(volumeData, regionSizeArr, isovalue);
      return NaiveSurfaceNets.constructTHREEGeometry(result);
    }
  }
}
