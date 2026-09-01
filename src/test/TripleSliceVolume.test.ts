import { describe, expect, it, vi } from "vitest";
import { Euler, Vector3, type Object3D } from "three";

vi.mock("../constants/volumeSliceShader.js", () => ({
  sliceVertexShaderSrc: "",
  sliceFragmentShaderSrc: "",
  sliceShaderUniforms: () =>
    Object.fromEntries(
      [
        "AABB_CLIP_MAX",
        "AABB_CLIP_MIN",
        "ATLAS_DIMS",
        "BRIGHTNESS",
        "DENSITY",
        "flipVolume",
        "GAMMA_MAX",
        "GAMMA_MIN",
        "GAMMA_SCALE",
        "interpolationEnabled",
        "inverseModelViewMatrix",
        "iResolution",
        "isOrtho",
        "maskAlpha",
        "orthoScale",
        "orthoThickness",
        "SLICE_INDEX",
        "SLICES",
        "textureAtlas",
        "textureAtlasMask",
        "textureRes",
        "viewAxis",
        "volumeScale",
        "volumeSize",
      ].map((name) => [name, { value: null }])
    ),
}));

vi.mock("../FusedChannelData.js", () => ({
  default: class MockFusedChannelData {
    width: number;
    height: number;
    maskTexture = null;

    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }

    cleanup(): void {
      return;
    }
    setChannelAsMask(): void {
      return;
    }
    fuse(): void {
      return;
    }
    gpuFuse(): void {
      return;
    }
    getFusedTexture(): null {
      return null;
    }
  },
}));

import type { ImageInfo } from "../ImageInfo.js";
import TripleSliceVolume from "../TripleSliceVolume.js";
import Volume from "../Volume.js";
import { SettingsFlags, VolumeRenderSettings } from "../VolumeRenderSettings.js";

const imageInfo: ImageInfo = {
  name: "anisotropic",
  atlasTileDims: [3, 2],
  subregionSize: [20, 10, 5],
  subregionOffset: [0, 0, 0],
  numChannelsPerSource: [1],
  channelNames: ["0"],
  multiscaleLevel: 0,
  multiscaleLevelDims: [
    {
      shape: [1, 1, 5, 10, 20],
      spacing: [1, 1, 1, 1, 1],
      spaceUnit: "px",
      timeUnit: "s",
      dataType: "uint8",
    },
  ],
  transform: {
    translation: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  },
};

function projectionPlane(projection: Object3D): Object3D {
  return projection.children.find((child) => child.name === "Plane")!;
}

describe("TripleSliceVolume", () => {
  it("initializes each projection plane with its axis-specific dimensions", () => {
    // Arrange
    const volume = new Volume(imageInfo);

    // Act
    const renderer = new TripleSliceVolume(volume, new VolumeRenderSettings(volume));
    const [xy, yz, xz] = renderer.get3dObject().children;

    // Assert
    // (Z=5, Y=10, X=20) normalizes to (Z=0.25, Y=0.5, X=1)
    // The third coordinate of .scale is unused for these 2D planes
    expect(projectionPlane(xy).scale.toArray().slice(0, 2)).toEqual([1, 0.5]);
    expect(projectionPlane(yz).scale.toArray().slice(0, 2)).toEqual([0.25, 0.5]);
    expect(projectionPlane(xz).scale.toArray().slice(0, 2)).toEqual([1, 0.25]);

    // Cleanup
    renderer.cleanup();
  });

  it("ignores the complete alignment transform in the fixed projection layout", () => {
    // Arrange
    const volume = new Volume(imageInfo);
    const settings = new VolumeRenderSettings(volume);
    settings.translation = new Vector3(0.25, -0.5, 0.75);
    settings.rotation = new Euler(0.1, 0.2, 0.3);
    settings.scale = new Vector3(2, 3, 4);
    settings.resolution.set(1200, 900);

    // Act: build the renderer and apply a view/sampling update
    const renderer = new TripleSliceVolume(volume, settings);
    renderer.updateSettings(settings, SettingsFlags.VIEW | SettingsFlags.SAMPLING);
    const panePositions = renderer.get3dObject().children.map((projection) => projection.position.toArray());

    // Sanity Check: the three panes occupy distinct positions before we assert they stay fixed
    expect(new Set(panePositions.map((position) => position.join(","))).size).toBe(3);

    // Assert: pane positions/rotations and per-axis scale reflect only the fixed layout
    for (const [index, projection] of renderer.get3dObject().children.entries()) {
      expect(projection.position.toArray()).toEqual(panePositions[index]);
      expect([projection.rotation.x, projection.rotation.y, projection.rotation.z]).toEqual([0, 0, 0]);
    }
    const [xy, yz, xz] = renderer.get3dObject().children;
    expect(projectionPlane(xy).scale.toArray()).toEqual([1, 0.5, 0.25]);
    expect(projectionPlane(yz).scale.toArray()).toEqual([0.25, 0.5, 1]);
    expect(projectionPlane(xz).scale.toArray()).toEqual([1, 0.25, 1]);

    // Act: apply a full alignment transform update (translation/rotation/scale)
    settings.translation.set(-0.1, 0.2, -0.3);
    settings.rotation.set(0.4, 0.5, 0.6);
    settings.scale.set(5, 6, 7);
    renderer.updateSettings(settings, SettingsFlags.TRANSFORM);
    renderer.updateVolumeDimensions();

    // Assert: layout is still unaffected by the transform, even though the settings themselves changed
    for (const [index, projection] of renderer.get3dObject().children.entries()) {
      expect(projection.position.toArray()).toEqual(panePositions[index]);
      expect([projection.rotation.x, projection.rotation.y, projection.rotation.z]).toEqual([0, 0, 0]);
    }
    expect(projectionPlane(xy).scale.toArray()).toEqual([1, 0.5, 0.25]);
    expect(projectionPlane(yz).scale.toArray()).toEqual([0.25, 0.5, 1]);
    expect(projectionPlane(xz).scale.toArray()).toEqual([1, 0.25, 1]);
    expect(settings.translation.toArray()).toEqual([-0.1, 0.2, -0.3]);
    expect([settings.rotation.x, settings.rotation.y, settings.rotation.z]).toEqual([0.4, 0.5, 0.6]);
    expect(settings.scale.toArray()).toEqual([5, 6, 7]);

    // Cleanup
    renderer.cleanup();
  });
});
