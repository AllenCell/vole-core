import { describe, expect, it, vi } from "vitest";

import Volume from "../Volume.js";
import VolumeMaker from "../VolumeMaker.js";
import { LUT_ARRAY_LENGTH } from "../Lut.js";
import Channel from "../Channel.js";
import { CImageInfo, ImageInfo } from "../ImageInfo.js";
import { IVolumeLoader, LoadSpec } from "../loaders/IVolumeLoader.js";
import { getDataRange } from "../utils/num_utils.js";

// PREPARE SOME TEST DATA TO TRY TO DISPLAY A VOLUME.
const testimgdata: ImageInfo = {
  name: "AICS-10_5_5",

  atlasTileDims: [7, 10],
  subregionSize: [204, 292, 65],
  subregionOffset: [0, 0, 0],
  numChannelsPerSource: [9],
  channelNames: [
    "DRAQ5",
    "EGFP",
    "Hoechst 33258",
    "TL Brightfield",
    "SEG_STRUCT",
    "SEG_Memb",
    "SEG_DNA",
    "CON_Memb",
    "CON_DNA",
  ],
  multiscaleLevel: 0,
  multiscaleLevelDims: [
    {
      shape: [1, 9, 65, 292, 204],
      // original volume had 0.065 um pixels in x and y, 0.29 um pixels in z, and 65x494x306 voxels
      spacing: [1, 1, 0.29, (0.065 * 494) / 292, (0.065 * 306) / 204],
      spaceUnit: "",
      timeUnit: "",
      dataType: "uint8",
    },
  ],

  transform: {
    translation: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  },
};

const multiscaleTestimgdata: ImageInfo = {
  ...testimgdata,
  multiscaleLevelDims: [
    ...testimgdata.multiscaleLevelDims,
    {
      shape: [1, 9, 33, 146, 102],
      spacing: [1, 1, 0.58, (0.065 * 494) / 146, (0.065 * 306) / 102],
      spaceUnit: "",
      timeUnit: "",
      dataType: "uint8",
    },
  ],
};

function createTestLoader(multiscaleLevelDims: ImageInfo["multiscaleLevelDims"]): IVolumeLoader {
  return {
    loadDims: vi.fn().mockResolvedValue(multiscaleLevelDims),
    createVolume: vi.fn(),
    loadVolumeData: vi.fn(),
    setPrefetchPriority: vi.fn(),
    syncMultichannelLoading: vi.fn(),
  };
}

function checkVolumeConstruction(v: Volume, imgdata: ImageInfo) {
  expect(v).to.be.a("Object");
  expect(v.isLoaded()).to.not.be.ok;

  const { originalSize, physicalPixelSize } = new CImageInfo(imgdata);
  const physicalSize = originalSize.clone().multiply(physicalPixelSize);
  expect(v.physicalSize.x).to.equal(physicalSize.x);
  expect(v.physicalSize.y).to.equal(physicalSize.y);
  expect(v.physicalSize.z).to.equal(physicalSize.z);

  const totalChannels = imgdata.numChannelsPerSource.reduce((a, b) => a + b, 0);
  expect(v.channelNames.length).to.equal(totalChannels);
  expect(v.channels.length).to.equal(totalChannels);

  const mx = Math.max(Math.max(v.normPhysicalSize.x, v.normPhysicalSize.y), v.normPhysicalSize.z);
  expect(mx).to.equal(1.0);
}

function checkChannelDataConstruction(c: Channel, index: number, imgdata: ImageInfo) {
  expect(c.loaded).to.be.true;
  expect(c.name).to.equal(imgdata.channelNames[index]);
  const atlasWidth = imgdata.atlasTileDims[0] * imgdata.subregionSize[0];
  const atlasHeight = imgdata.atlasTileDims[1] * imgdata.subregionSize[1];
  expect(c.imgData.width).to.equal(atlasWidth);
  expect(c.imgData.height).to.equal(atlasHeight);
  expect(c.imgData.data).to.be.a("Uint8Array");
  expect(c.imgData.data.length).to.equal(atlasWidth * atlasHeight);
  expect(c.lut.lut).to.be.a("Uint8Array");
  expect(c.lut.lut.length).to.equal(LUT_ARRAY_LENGTH);
}

describe("test volume", () => {
  describe("creation", () => {
    const v = new Volume(testimgdata);

    it("is created", () => {
      checkVolumeConstruction(v, testimgdata);
    });

    it("loaded channel data", () => {
      const size = v.imageInfo.subregionSize;

      const conedata = VolumeMaker.createCone(size.x, size.y, size.z, size.x / 8, size.z);

      v.setChannelDataFromVolume(0, conedata, getDataRange(conedata));

      const c0 = v.getChannel(0);
      checkChannelDataConstruction(c0, 0, testimgdata);

      const spheredata = VolumeMaker.createSphere(size.x, size.y, size.z, size.z / 4);

      v.setChannelDataFromVolume(1, spheredata, getDataRange(spheredata));

      const c1 = v.getChannel(1);
      checkChannelDataConstruction(c1, 1, testimgdata);

      expect(v.getIntensity(1, Math.floor(size.x / 2), Math.floor(size.y / 2), Math.floor(size.z / 2))).to.equal(255);
      expect(v.getIntensity(1, 0, 0, 0)).to.equal(0);
    });
  });

  describe("property validation", () => {
    it("has a correct value for normalizedPhysicalSize", () => {
      // `Volume` formerly derived a `scale` property by a different means than `normPhysicalSize`, but depended
      // on `scale` and `normPhysicalSize` being equal. With `scale` gone, this test ensures the equality stays.
      const v = new Volume(testimgdata);
      const { originalSize, physicalPixelSize } = v.imageInfo;
      const sizemax = Math.max(
        originalSize.x * physicalPixelSize.x,
        originalSize.y * physicalPixelSize.y,
        originalSize.z * physicalPixelSize.z
      );

      const sx = (physicalPixelSize.x * originalSize.x) / sizemax;
      const sy = (physicalPixelSize.y * originalSize.y) / sizemax;
      const sz = (physicalPixelSize.z * originalSize.z) / sizemax;

      const EPSILON = 0.000000001;
      expect(v.normPhysicalSize.x).to.be.closeTo(sx, EPSILON);
      expect(v.normPhysicalSize.y).to.be.closeTo(sy, EPSILON);
      expect(v.normPhysicalSize.z).to.be.closeTo(sz, EPSILON);
    });
  });

  describe("loading events", () => {
    it("dispatches loadStart when changing scale levels", async () => {
      // ARRANGE
      const loader = createTestLoader(multiscaleTestimgdata.multiscaleLevelDims);
      const v = new Volume(multiscaleTestimgdata, new LoadSpec(), loader);
      const loadStart = vi.fn();
      v.addEventListener("loadStart", loadStart);

      // ACT: Simulate beginning scrubbing
      await v.updateRequiredData({ scaleLevelBias: 1 });

      // ASSERT
      expect(loadStart).toHaveBeenCalled();
    });

    it("does not dispatch loadStart when no reload is required", async () => {
      // ARRANGE
      // loader is needed for loadStart to potentially be triggered
      const loader = createTestLoader(testimgdata.multiscaleLevelDims);
      const v = new Volume(testimgdata, new LoadSpec(), loader);
      const loadStart = vi.fn();
      v.addEventListener("loadStart", loadStart);

      // ACT: Simulate beginning scrubbing
      await v.updateRequiredData({ scaleLevelBias: 1 });

      // ASSERT: `testimgdata` has only one multiscale level, so
      // changing scaleLevelBias should not trigger any load.
      expect(loadStart).not.toHaveBeenCalled();
    });
  });
});
