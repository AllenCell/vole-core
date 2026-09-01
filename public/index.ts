import { Color, Vector3 } from "three";
import GUI from "lil-gui";

import { colormaps as colorizercolormaps, features as colorizerfeatures } from "./colorizer.js";
import {
  CreateLoaderOptions,
  ImageInfo,
  IVolumeLoader,
  LoadSpec,
  Lut,
  JsonImageInfoLoader,
  RawArrayInfo,
  View3d,
  Volume,
  VolumeMaker,
  Light,
  AREA_LIGHT,
  RENDERMODE_PATHTRACE,
  RENDERMODE_RAYMARCH,
  SKY_LIGHT,
  VolumeFileFormat,
} from "../src/index.js";
// special loader really just for this demo app but lives with the other loaders
import { OpenCellLoader } from "../src/loaders/OpenCellLoader.js";
import { State, TestDataSpec } from "./types.js";
import VolumeLoaderContext from "../src/workers/VolumeLoaderContext.js";
import { DATARANGE_UINT8, ColorizeFeature, type NumberType } from "../src/types.js";
import { RawArrayLoaderOptions } from "../src/loaders/RawArrayLoader.js";

const CACHE_MAX_SIZE = 1_000_000_000;
const CONCURRENCY_LIMIT = 8;
const PREFETCH_CONCURRENCY_LIMIT = 3;
const PREFETCH_DISTANCE: [number, number, number, number] = [5, 5, 5, 5];
const MAX_PREFETCH_CHUNKS = 25;
const PLAYBACK_INTERVAL = 80;

const TEST_DATA: Record<string, TestDataSpec> = {
  cellpainting: {
    type: VolumeFileFormat.TIFF,
    url: [
      [
        "https://cellpainting-gallery.s3.us-east-1.amazonaws.com/cpg0000-jump-pilot/source_4/images/2020_12_08_CPJUMP1_Bleaching/images/BR00116992E__2020-11-12T01_22_40-Measurement1/Images/r01c01f01p01-ch1sk5fk1fl1.tiff",
        "https://cellpainting-gallery.s3.us-east-1.amazonaws.com/cpg0000-jump-pilot/source_4/images/2020_12_08_CPJUMP1_Bleaching/images/BR00116992E__2020-11-12T01_22_40-Measurement1/Images/r01c01f01p01-ch2sk5fk1fl1.tiff",
        "https://cellpainting-gallery.s3.us-east-1.amazonaws.com/cpg0000-jump-pilot/source_4/images/2020_12_08_CPJUMP1_Bleaching/images/BR00116992E__2020-11-12T01_22_40-Measurement1/Images/r01c01f01p01-ch3sk5fk1fl1.tiff",
        "https://cellpainting-gallery.s3.us-east-1.amazonaws.com/cpg0000-jump-pilot/source_4/images/2020_12_08_CPJUMP1_Bleaching/images/BR00116992E__2020-11-12T01_22_40-Measurement1/Images/r01c01f01p01-ch4sk5fk1fl1.tiff",
        "https://cellpainting-gallery.s3.us-east-1.amazonaws.com/cpg0000-jump-pilot/source_4/images/2020_12_08_CPJUMP1_Bleaching/images/BR00116992E__2020-11-12T01_22_40-Measurement1/Images/r01c01f01p01-ch5sk5fk1fl1.tiff",
        "https://cellpainting-gallery.s3.us-east-1.amazonaws.com/cpg0000-jump-pilot/source_4/images/2020_12_08_CPJUMP1_Bleaching/images/BR00116992E__2020-11-12T01_22_40-Measurement1/Images/r01c01f01p01-ch6sk5fk1fl1.tiff",
        "https://cellpainting-gallery.s3.us-east-1.amazonaws.com/cpg0000-jump-pilot/source_4/images/2020_12_08_CPJUMP1_Bleaching/images/BR00116992E__2020-11-12T01_22_40-Measurement1/Images/r01c01f01p01-ch7sk5fk1fl1.tiff",
        "https://cellpainting-gallery.s3.us-east-1.amazonaws.com/cpg0000-jump-pilot/source_4/images/2020_12_08_CPJUMP1_Bleaching/images/BR00116992E__2020-11-12T01_22_40-Measurement1/Images/r01c01f01p01-ch8sk5fk1fl1.tiff",
      ],
    ],
  },
  testpick: {
    type: VolumeFileFormat.ZARR,
    url: "https://allencell.s3.amazonaws.com/aics/nuc-morph-dataset/hipsc_fov_nuclei_timelapse_dataset/hipsc_fov_nuclei_timelapse_data_used_for_analysis/baseline_colonies_fov_timelapse_dataset/20200323_09_small/seg.ome.zarr",
  },
  timeSeries: {
    type: VolumeFileFormat.JSON,
    url: "https://animatedcell-test-data.s3.us-west-2.amazonaws.com/timelapse/test_parent_T49.ome_%%_atlas.json",
    times: 46,
  },
  omeTiff: {
    type: VolumeFileFormat.TIFF,
    url: "https://animatedcell-test-data.s3.us-west-2.amazonaws.com/AICS-12_881.ome.tif",
  },
  zarrEMT: {
    url: "https://dev-aics-dtp-001.int.allencell.org/dan-data/3500005818_20230811__20x_Timelapse-02(P27-E7).ome.zarr",
    type: VolumeFileFormat.ZARR,
  },
  zarrIDR1: {
    type: VolumeFileFormat.ZARR,
    url: "https://uk1s3.embassy.ebi.ac.uk/idr/zarr/v0.4/idr0076A/10501752.zarr",
  },
  zarrIDR2: {
    type: VolumeFileFormat.ZARR,
    url: "https://uk1s3.embassy.ebi.ac.uk/idr/zarr/v0.4/idr0054A/5025553.zarr",
  },
  zarrVariance: {
    type: VolumeFileFormat.ZARR,
    url: [
      "https://animatedcell-test-data.s3.us-west-2.amazonaws.com/variance/1.zarr",
      "https://animatedcell-test-data.s3.us-west-2.amazonaws.com/variance/2.zarr",
    ],
  },
  zarrNucmorph0: {
    type: VolumeFileFormat.ZARR,
    url: "https://animatedcell-test-data.s3.us-west-2.amazonaws.com/20200323_F01_001/P13-C4.zarr/",
  },
  zarrNucmorph1: {
    type: VolumeFileFormat.ZARR,
    url: "https://animatedcell-test-data.s3.us-west-2.amazonaws.com/20200323_F01_001/P15-C3.zarr/",
  },
  zarrNucmorph2: {
    type: VolumeFileFormat.ZARR,
    url: "https://animatedcell-test-data.s3.us-west-2.amazonaws.com/20200323_F01_001/P7-B4.zarr/",
  },
  zarrNucmorph3: {
    type: VolumeFileFormat.ZARR,
    url: "https://animatedcell-test-data.s3.us-west-2.amazonaws.com/20200323_F01_001/P8-B4.zarr/",
  },
  zarrFlyBrain: {
    type: VolumeFileFormat.ZARR,
    url: "https://uk1s3.embassy.ebi.ac.uk/idr/zarr/v0.4/idr0048A/9846152.zarr/",
  },
  zarrUK: {
    type: VolumeFileFormat.ZARR,
    url: "https://uk1s3.embassy.ebi.ac.uk/idr/zarr/v0.4/idr0062A/6001240.zarr",
  },
  zarrHumanOrganAtlas: {
    type: VolumeFileFormat.ZARR,
    url: "gs://ucl-hip-ct-35a68e99feaae8932b1d44da0358940b/A186/lung-right/24.132um_complete-organ_bm18.ome.zarr/",
  },
  opencell: { type: "opencell", url: "" },
  cfeJson: {
    type: VolumeFileFormat.JSON,
    url: "AICS-12_881_atlas.json",
  },
  abm: {
    type: VolumeFileFormat.TIFF,
    url: "https://animatedcell-test-data.s3.us-west-2.amazonaws.com/HAMILTONIAN_TERM_FOV_VSAHJUP_0000_000192.ome.tif",
  },
  procedural: { type: VolumeFileFormat.DATA, url: "", dtype: "uint8" },
  procedural2: { type: VolumeFileFormat.DATA, url: "", dtype: "uint16" },
  procedural3: { type: VolumeFileFormat.DATA, url: "", dtype: "float32" },
};

let view3D: View3d;

const loaderContext = new VolumeLoaderContext(CACHE_MAX_SIZE, CONCURRENCY_LIMIT, PREFETCH_CONCURRENCY_LIMIT);

const myState: State = {
  file: "",
  volume: new Volume(),
  currentFrame: 0,
  lastFrameTime: 0,
  isPlaying: false,
  timerId: 0,
  scene: 0,

  loader: [
    new JsonImageInfoLoader(
      "https://animatedcell-test-data.s3.us-west-2.amazonaws.com/timelapse/test_parent_T49.ome_%%_atlas.json"
    ),
  ],

  density: 12.5,
  maskAlpha: 1.0,
  exposure: 0.75,
  aperture: 0.0,
  fov: 20,
  focalDistance: 4.0,

  lights: [new Light(SKY_LIGHT), new Light(AREA_LIGHT)],

  skyTopIntensity: 0.3,
  skyMidIntensity: 0.3,
  skyBotIntensity: 0.3,
  skyTopColor: [255, 255, 255],
  skyMidColor: [255, 255, 255],
  skyBotColor: [255, 255, 255],

  lightColor: [255, 255, 255],
  lightIntensity: 75.0,
  lightTheta: 14, //deg
  lightPhi: 54, //deg

  xmin: 0.0,
  ymin: 0.0,
  zmin: 0.0,
  xmax: 1.0,
  ymax: 1.0,
  zmax: 1.0,

  samplingRate: 0.25,
  primaryRay: 1.0,
  secondaryRay: 1.0,

  isPT: false,
  isMP: false,
  interpolationActive: true,

  isTurntable: false,
  isAxisShowing: false,
  isAligned: true,

  showScaleBar: true,

  showBoundingBox: false,
  boundingBoxColor: [255, 255, 0],
  backgroundColor: [0, 0, 0],
  flipX: 1,
  flipY: 1,
  flipZ: 1,

  channelFolderNames: [],
  channelGui: [],

  currentImageStore: "",
  currentImageName: "",

  colorizeEnabled: false,
  colorizeChannel: 0,
  feature: "feature1",
  colormap: "viridis",
  featureMin: 0.0,
  featureMax: 1.0,
};

const getNumberOfTimesteps = (): number => myState.totalFrames || myState.volume.imageInfo.times;

function densitySliderToView3D(density: number) {
  return density / 50.0;
}
// controlPoints is array of [{offset:number, color:cssstring}]
// where offset is a value from 0.0 to 1.0, and color is a string encoding a css color value.
// first and last control points should be at offsets 0 and 1
// TODO: what if offsets 0 and 1 are not provided?
// makeColorGradient([
//    {offset:0, color:"black"},
//    {offset:0.2, color:"black"},
//    {offset:0.25, color:"red"},
//    {offset:0.5, color:"orange"}
//    {offset:1.0, color:"yellow"}
//]);
/*
function makeColorGradient(controlPoints) {
  const c = document.createElement("canvas");
  c.style.height = 1;
  c.style.width = 256;
  c.height = 1;
  c.width = 256;

  const ctx = c.getContext("2d");
  const grd = ctx.createLinearGradient(0, 0, 255, 0);
  if (!controlPoints.length || controlPoints.length < 1) {
    console.log("warning: bad control points submitted to makeColorGradient; reverting to linear greyscale gradient");
    grd.addColorStop(0, "black");
    grd.addColorStop(1, "white");
  } else {
    // what if none at 0 and none at 1?
    for (let i = 0; i < controlPoints.length; ++i) {
      grd.addColorStop(controlPoints[i].offset, controlPoints[i].color);
    }
  }

  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, 256, 1);
  const imgData = ctx.getImageData(0, 0, 256, 1);
  // console.log(imgData.data);
  return imgData.data;
}
*/
function initLights() {
  myState.lights[0].mColorTop = new Vector3(
    (myState.skyTopColor[0] / 255.0) * myState.skyTopIntensity,
    (myState.skyTopColor[1] / 255.0) * myState.skyTopIntensity,
    (myState.skyTopColor[2] / 255.0) * myState.skyTopIntensity
  );
  myState.lights[0].mColorMiddle = new Vector3(
    (myState.skyMidColor[0] / 255.0) * myState.skyMidIntensity,
    (myState.skyMidColor[1] / 255.0) * myState.skyMidIntensity,
    (myState.skyMidColor[2] / 255.0) * myState.skyMidIntensity
  );
  myState.lights[0].mColorBottom = new Vector3(
    (myState.skyBotColor[0] / 255.0) * myState.skyBotIntensity,
    (myState.skyBotColor[1] / 255.0) * myState.skyBotIntensity,
    (myState.skyBotColor[2] / 255.0) * myState.skyBotIntensity
  );
  myState.lights[1].mTheta = (myState.lightTheta * Math.PI) / 180.0;
  myState.lights[1].mPhi = (myState.lightPhi * Math.PI) / 180.0;
  myState.lights[1].mColor = new Vector3(
    (myState.lightColor[0] / 255.0) * myState.lightIntensity,
    (myState.lightColor[1] / 255.0) * myState.lightIntensity,
    (myState.lightColor[2] / 255.0) * myState.lightIntensity
  );
  view3D.updateLights(myState.lights);
}

function setInitialRenderMode() {
  if (myState.isPT && myState.isMP) {
    myState.isMP = false;
  }
  view3D.setVolumeRenderMode(myState.isPT ? RENDERMODE_PATHTRACE : RENDERMODE_RAYMARCH);
  view3D.setMaxProjectMode(myState.volume, myState.isMP);
}

let gui: GUI;

function setupGui() {
  gui = new GUI();

  gui
    .add(myState, "density")
    .max(100.0)
    .min(0.0)
    .step(0.001)
    .onChange(function (value) {
      view3D.updateDensity(myState.volume, densitySliderToView3D(value));
    });
  gui
    .add(myState, "maskAlpha")
    .max(1.0)
    .min(0.0)
    .step(0.001)
    .onChange(function (value) {
      view3D.updateMaskAlpha(myState.volume, value);
    });
  gui
    .add(myState, "primaryRay")
    .max(40.0)
    .min(1.0)
    .step(0.1)
    .onChange(function () {
      view3D.setRayStepSizes(myState.volume, myState.primaryRay, myState.secondaryRay);
    });
  gui
    .add(myState, "secondaryRay")
    .max(40.0)
    .min(1.0)
    .step(0.1)
    .onChange(function () {
      view3D.setRayStepSizes(myState.volume, myState.primaryRay, myState.secondaryRay);
    });

  const cameraGui = gui.addFolder("Camera").close();
  cameraGui
    .add(myState, "exposure")
    .max(1.0)
    .min(0.0)
    .step(0.001)
    .onChange(function (value) {
      view3D.updateExposure(value);
    });
  cameraGui
    .add(myState, "aperture")
    .max(0.1)
    .min(0.0)
    .step(0.001)
    .onChange(function () {
      view3D.updateCamera(myState.fov, myState.focalDistance, myState.aperture);
    });
  cameraGui
    .add(myState, "focalDistance")
    .max(5.0)
    .min(0.1)
    .step(0.001)
    .onChange(function () {
      view3D.updateCamera(myState.fov, myState.focalDistance, myState.aperture);
    });
  cameraGui
    .add(myState, "fov")
    .max(90.0)
    .min(0.0)
    .step(0.001)
    .onChange(function () {
      view3D.updateCamera(myState.fov, myState.focalDistance, myState.aperture);
    });
  cameraGui
    .add(myState, "samplingRate")
    .max(1.0)
    .min(0.1)
    .step(0.001)
    .onChange(function (value) {
      view3D.updatePixelSamplingRate(value);
    });

  const clipping = gui.addFolder("Clipping Box").close();
  clipping
    .add(myState, "xmin")
    .max(1.0)
    .min(0.0)
    .step(0.001)
    .onChange(function () {
      view3D.updateClipRegion(
        myState.volume,
        myState.xmin,
        myState.xmax,
        myState.ymin,
        myState.ymax,
        myState.zmin,
        myState.zmax
      );
    });
  clipping
    .add(myState, "xmax")
    .max(1.0)
    .min(0.0)
    .step(0.001)
    .onChange(function () {
      view3D.updateClipRegion(
        myState.volume,
        myState.xmin,
        myState.xmax,
        myState.ymin,
        myState.ymax,
        myState.zmin,
        myState.zmax
      );
    });
  clipping
    .add(myState, "ymin")
    .max(1.0)
    .min(0.0)
    .step(0.001)
    .onChange(function () {
      view3D.updateClipRegion(
        myState.volume,
        myState.xmin,
        myState.xmax,
        myState.ymin,
        myState.ymax,
        myState.zmin,
        myState.zmax
      );
    });
  clipping
    .add(myState, "ymax")
    .max(1.0)
    .min(0.0)
    .step(0.001)
    .onChange(function () {
      view3D.updateClipRegion(
        myState.volume,
        myState.xmin,
        myState.xmax,
        myState.ymin,
        myState.ymax,
        myState.zmin,
        myState.zmax
      );
    });
  clipping
    .add(myState, "zmin")
    .max(1.0)
    .min(0.0)
    .step(0.001)
    .onChange(function () {
      view3D.updateClipRegion(
        myState.volume,
        myState.xmin,
        myState.xmax,
        myState.ymin,
        myState.ymax,
        myState.zmin,
        myState.zmax
      );
    });
  clipping
    .add(myState, "zmax")
    .max(1.0)
    .min(0.0)
    .step(0.001)
    .onChange(function () {
      view3D.updateClipRegion(
        myState.volume,
        myState.xmin,
        myState.xmax,
        myState.ymin,
        myState.ymax,
        myState.zmin,
        myState.zmax
      );
    });

  const lighting = gui.addFolder("Lighting").close();
  lighting
    .addColor(myState, "skyTopColor", 255)
    .name("Sky Top")
    .onChange(function () {
      myState.lights[0].mColorTop = new Vector3(
        (myState.skyTopColor[0] / 255.0) * myState.skyTopIntensity,
        (myState.skyTopColor[1] / 255.0) * myState.skyTopIntensity,
        (myState.skyTopColor[2] / 255.0) * myState.skyTopIntensity
      );
      view3D.updateLights(myState.lights);
    });
  lighting
    .add(myState, "skyTopIntensity")
    .max(100.0)
    .min(0.01)
    .step(0.1)
    .onChange(function () {
      myState.lights[0].mColorTop = new Vector3(
        (myState.skyTopColor[0] / 255.0) * myState.skyTopIntensity,
        (myState.skyTopColor[1] / 255.0) * myState.skyTopIntensity,
        (myState.skyTopColor[2] / 255.0) * myState.skyTopIntensity
      );
      view3D.updateLights(myState.lights);
    });
  lighting
    .addColor(myState, "skyMidColor", 255)
    .name("Sky Mid")
    .onChange(function () {
      myState.lights[0].mColorMiddle = new Vector3(
        (myState.skyMidColor[0] / 255.0) * myState.skyMidIntensity,
        (myState.skyMidColor[1] / 255.0) * myState.skyMidIntensity,
        (myState.skyMidColor[2] / 255.0) * myState.skyMidIntensity
      );
      view3D.updateLights(myState.lights);
    });
  lighting
    .add(myState, "skyMidIntensity")
    .max(100.0)
    .min(0.01)
    .step(0.1)
    .onChange(function () {
      myState.lights[0].mColorMiddle = new Vector3(
        (myState.skyMidColor[0] / 255.0) * myState.skyMidIntensity,
        (myState.skyMidColor[1] / 255.0) * myState.skyMidIntensity,
        (myState.skyMidColor[2] / 255.0) * myState.skyMidIntensity
      );
      view3D.updateLights(myState.lights);
    });
  lighting
    .addColor(myState, "skyBotColor", 255)
    .name("Sky Bottom")
    .onChange(function () {
      myState.lights[0].mColorBottom = new Vector3(
        (myState.skyBotColor[0] / 255.0) * myState.skyBotIntensity,
        (myState.skyBotColor[1] / 255.0) * myState.skyBotIntensity,
        (myState.skyBotColor[2] / 255.0) * myState.skyBotIntensity
      );
      view3D.updateLights(myState.lights);
    });
  lighting
    .add(myState, "skyBotIntensity")
    .max(100.0)
    .min(0.01)
    .step(0.1)
    .onChange(function () {
      myState.lights[0].mColorBottom = new Vector3(
        (myState.skyBotColor[0] / 255.0) * myState.skyBotIntensity,
        (myState.skyBotColor[1] / 255.0) * myState.skyBotIntensity,
        (myState.skyBotColor[2] / 255.0) * myState.skyBotIntensity
      );
      view3D.updateLights(myState.lights);
    });
  lighting
    .add(myState.lights[1], "mDistance")
    .max(10.0)
    .min(0.0)
    .step(0.1)
    .onChange(function () {
      view3D.updateLights(myState.lights);
    });
  lighting
    .add(myState, "lightTheta")
    .max(180.0)
    .min(-180.0)
    .step(1)
    .onChange(function (value) {
      myState.lights[1].mTheta = (value * Math.PI) / 180.0;
      view3D.updateLights(myState.lights);
    });
  lighting
    .add(myState, "lightPhi")
    .max(180.0)
    .min(0.0)
    .step(1)
    .onChange(function (value) {
      myState.lights[1].mPhi = (value * Math.PI) / 180.0;
      view3D.updateLights(myState.lights);
    });
  lighting
    .add(myState.lights[1], "mWidth")
    .max(100.0)
    .min(0.01)
    .step(0.1)
    .onChange(function (value) {
      myState.lights[1].mWidth = value;
      myState.lights[1].mHeight = value;
      view3D.updateLights(myState.lights);
    });
  lighting
    .add(myState, "lightIntensity")
    .max(1000.0)
    .min(0.01)
    .step(0.1)
    .onChange(function () {
      myState.lights[1].mColor = new Vector3(
        (myState.lightColor[0] / 255.0) * myState.lightIntensity,
        (myState.lightColor[1] / 255.0) * myState.lightIntensity,
        (myState.lightColor[2] / 255.0) * myState.lightIntensity
      );
      view3D.updateLights(myState.lights);
    });
  lighting
    .addColor(myState, "lightColor", 255)
    .name("lightColor")
    .onChange(function () {
      myState.lights[1].mColor = new Vector3(
        (myState.lightColor[0] / 255.0) * myState.lightIntensity,
        (myState.lightColor[1] / 255.0) * myState.lightIntensity,
        (myState.lightColor[2] / 255.0) * myState.lightIntensity
      );
      view3D.updateLights(myState.lights);
    });

  initLights();
}

function removeFolderByName(name: string) {
  const folder = gui.folders.find((f) => f._title === name);
  if (!folder) {
    return;
  }
  folder.close();
  folder.destroy();
}

function updateTimeUI() {
  const totalFrames = getNumberOfTimesteps();

  const timeSlider = document.getElementById("timeSlider") as HTMLInputElement;
  if (timeSlider) {
    timeSlider.max = `${totalFrames - 1}`;
  }
  const timeInput = document.getElementById("timeValue") as HTMLInputElement;
  if (timeInput) {
    timeInput.max = `${totalFrames - 1}`;
  }

  const playBtn = document.getElementById("playBtn");
  if (totalFrames < 2) {
    (playBtn as HTMLButtonElement).disabled = true;
  } else {
    (playBtn as HTMLButtonElement).disabled = false;
  }
  const pauseBtn = document.getElementById("pauseBtn");
  if (totalFrames < 2) {
    (pauseBtn as HTMLButtonElement).disabled = true;
  } else {
    (pauseBtn as HTMLButtonElement).disabled = false;
  }
}

function updateScenesUI() {
  const maxSceneIndex = myState.loader.length - 1;
  const sceneInput = document.getElementById("sceneValue") as HTMLInputElement;
  sceneInput.max = `${maxSceneIndex}`;
  sceneInput.value = `${Math.min(myState.scene, maxSceneIndex)}`;
}

function updateChannelUI(vol: Volume, channelIndex: number) {
  const channel = vol.channels[channelIndex];

  const channelNames = vol.imageInfo.channelNames;
  const folder = gui.folders.find((f) => f._title === "Channel " + channelNames[channelIndex]);
  if (!folder) {
    return;
  }
  const isovalueUI = folder.controllers.find((c) => c._name === "isovalue");
  if (!isovalueUI) {
    return;
  }
  isovalueUI.min(channel.rawMin);
  isovalueUI.max(channel.rawMax);
}

function updateZSliceUI(volume: Volume) {
  const zSlider = document.getElementById("zSlider") as HTMLInputElement;
  const zInput = document.getElementById("zValue") as HTMLInputElement;

  const totalZSlices = volume.imageInfo.volumeSize.z;
  zSlider.max = `${totalZSlices - 1}`;
  zInput.max = `${totalZSlices - 1}`;

  zInput.value = `${Math.floor(totalZSlices / 2)}`;
  zSlider.value = `${Math.floor(totalZSlices / 2)}`;
}

function showChannelUI(volume: Volume) {
  if (myState && myState.channelFolderNames) {
    for (let i = 0; i < myState.channelFolderNames.length; ++i) {
      removeFolderByName(myState.channelFolderNames[i]);
    }
  }

  const nChannels = volume.imageInfo.numChannels;
  const channelNames = volume.imageInfo.channelNames;

  myState.channelGui = [];

  myState.channelFolderNames = [];
  for (let i = 0; i < nChannels; ++i) {
    myState.channelGui.push({
      colorD: volume.channelColorsDefault[i],
      colorS: [0, 0, 0],
      colorE: [0, 0, 0],
      window: 1.0,
      level: 0.5,
      glossiness: 0.0,
      isovalue: 128, // actual intensity value
      isosurface: false,
      // first 3 channels for starters
      enabled: i < 3,
      reset: (function (j) {
        return function () {
          const lut = new Lut().createFullRange();
          volume.setLut(j, lut);
          view3D.updateLuts(volume);
        };
      })(i),
      // this doesn't give good results currently but is an example of a per-channel button callback
      autoIJ: (function (j) {
        return function () {
          const [hmin, hmax] = volume.getHistogram(j).findAutoIJBins();
          const lut = new Lut().createFromMinMax(hmin, hmax);
          volume.setLut(j, lut);
          view3D.updateLuts(volume);
        };
      })(i),
      // this doesn't give good results currently but is an example of a per-channel button callback
      auto0: (function (j) {
        return function () {
          const [b, e] = volume.getHistogram(j).findAutoMinMax();
          const lut = new Lut().createFromMinMax(b, e);
          volume.setLut(j, lut);
          view3D.updateLuts(volume);
        };
      })(i),
      // this doesn't give good results currently but is an example of a per-channel button callback
      bestFit: (function (j) {
        return function () {
          const [hmin, hmax] = volume.getHistogram(j).findBestFitBins();
          const lut = new Lut().createFromMinMax(hmin, hmax);
          volume.setLut(j, lut);
          view3D.updateLuts(volume);
        };
      })(i),
      // eslint-disable-next-line @typescript-eslint/naming-convention
      pct50_98: (function (j) {
        return function () {
          const hmin = volume.getHistogram(j).findBinOfPercentile(0.5);
          const hmax = volume.getHistogram(j).findBinOfPercentile(0.983);
          const lut = new Lut().createFromMinMax(hmin, hmax);
          volume.setLut(j, lut);
          view3D.updateLuts(volume);
        };
      })(i),
      colorizeEnabled: false,
      colorize: (function (j) {
        return function () {
          const lut = new Lut().createLabelColors(volume.getHistogram(j));
          volume.setColorPalette(j, lut.lut);
          myState.channelGui[j].colorizeEnabled = !myState.channelGui[j].colorizeEnabled;
          if (myState.channelGui[j].colorizeEnabled) {
            volume.setColorPaletteAlpha(j, myState.channelGui[j].colorizeAlpha);
          } else {
            volume.setColorPaletteAlpha(j, 0);
          }

          view3D.updateLuts(volume);
        };
      })(i),
      colorizeAlpha: 0.0,
    });
    const f = gui.addFolder("Channel " + channelNames[i]);
    if (i > 0) {
      f.close();
    }
    myState.channelFolderNames.push("Channel " + channelNames[i]);
    f.add(myState.channelGui[i], "enabled").onChange(
      (function (j) {
        return function (value) {
          view3D.setVolumeChannelEnabled(volume, j, value ? true : false);
          view3D.updateActiveChannels(volume);
        };
      })(i)
    );
    f.add(myState.channelGui[i], "isosurface").onChange(
      (function (j) {
        return function (value) {
          view3D.setVolumeChannelOptions(volume, j, { isosurfaceEnabled: value });
        };
      })(i)
    );
    f.add(myState.channelGui[i], "isovalue")
      .max(255)
      .min(0)
      .step(1)
      .onChange(
        (function (j) {
          return function (value) {
            view3D.setVolumeChannelOptions(volume, j, { isovalue: value });
          };
        })(i)
      );

    f.addColor(myState.channelGui[i], "colorD", 255)
      .name("Diffuse")
      .onChange(
        (function (j) {
          return function () {
            view3D.updateChannelMaterial(
              volume,
              j,
              myState.channelGui[j].colorD,
              myState.channelGui[j].colorS,
              myState.channelGui[j].colorE,
              myState.channelGui[j].glossiness
            );
            view3D.updateMaterial(volume);
          };
        })(i)
      );
    f.addColor(myState.channelGui[i], "colorS", 255)
      .name("Specular")
      .onChange(
        (function (j) {
          return function () {
            view3D.updateChannelMaterial(
              volume,
              j,
              myState.channelGui[j].colorD,
              myState.channelGui[j].colorS,
              myState.channelGui[j].colorE,
              myState.channelGui[j].glossiness
            );
            view3D.updateMaterial(volume);
          };
        })(i)
      );
    f.addColor(myState.channelGui[i], "colorE", 255)
      .name("Emissive")
      .onChange(
        (function (j) {
          return function () {
            view3D.updateChannelMaterial(
              volume,
              j,
              myState.channelGui[j].colorD,
              myState.channelGui[j].colorS,
              myState.channelGui[j].colorE,
              myState.channelGui[j].glossiness
            );
            view3D.updateMaterial(volume);
          };
        })(i)
      );
    f.add(myState.channelGui[i], "window")
      .max(1.0)
      .min(0.0)
      .step(0.001)
      .onChange(
        (function (j) {
          return function (value) {
            const hwindow = value;
            const hlevel = myState.channelGui[j].level;
            const lut = new Lut().createFromWindowLevel(hwindow, hlevel);
            volume.setLut(j, lut);
            view3D.updateLuts(volume);
          };
        })(i)
      );

    f.add(myState.channelGui[i], "level")
      .max(1.0)
      .min(0.0)
      .step(0.001)
      .onChange(
        (function (j) {
          return function (value) {
            const hwindow = myState.channelGui[j].window;
            const hlevel = value;
            const lut = new Lut().createFromWindowLevel(hwindow, hlevel);
            volume.setLut(j, lut);
            view3D.updateLuts(volume);
          };
        })(i)
      );
    f.add(myState.channelGui[i], "reset");
    f.add(myState.channelGui[i], "autoIJ");
    f.add(myState.channelGui[i], "auto0");
    f.add(myState.channelGui[i], "bestFit");
    f.add(myState.channelGui[i], "pct50_98");
    f.add(myState.channelGui[i], "colorize");
    f.add(myState.channelGui[i], "colorizeAlpha")
      .max(1.0)
      .min(0.0)
      .onChange(
        (function (j) {
          return function (value) {
            if (myState.channelGui[j].colorizeEnabled) {
              volume.setColorPaletteAlpha(j, value);
              view3D.updateLuts(volume);
            }
          };
        })(i)
      );
    f.add(myState.channelGui[i], "glossiness")
      .max(100.0)
      .min(0.0)
      .onChange(
        (function (j) {
          return function () {
            view3D.updateChannelMaterial(
              volume,
              j,
              myState.channelGui[j].colorD,
              myState.channelGui[j].colorS,
              myState.channelGui[j].colorE,
              myState.channelGui[j].glossiness
            );
            view3D.updateMaterial(volume);
          };
        })(i)
      );
  }
}

function loadImageData(jsonData: ImageInfo, volumeData: Uint8Array<ArrayBuffer>[]) {
  const vol = new Volume(jsonData);
  myState.volume = vol;

  // tell the viewer about the image AFTER it's loaded
  //view3D.removeAllVolumes();
  //view3D.addVolume(vol);

  // get data into the image
  for (let i = 0; i < volumeData.length; ++i) {
    // where each volumeData element is a flat Uint8Array of xyz data
    // according to jsonData.tile_width*jsonData.tile_height*jsonData.tiles
    // (first row of first plane is the first data in
    // the layout, then second row of first plane, etc)
    vol.setChannelDataFromVolume(i, volumeData[i], DATARANGE_UINT8);

    setInitialRenderMode();

    view3D.removeAllVolumes();
    view3D.addVolume(vol);

    for (let ch = 0; ch < vol.imageInfo.numChannels; ++ch) {
      view3D.setVolumeChannelEnabled(vol, ch, myState.channelGui[ch].enabled);
    }

    const maskChannelIndex = jsonData.channelNames.indexOf("SEG_Memb");
    view3D.setVolumeChannelAsMask(vol, maskChannelIndex);
    view3D.updateActiveChannels(vol);
    view3D.updateLuts(vol);
    view3D.updateLights(myState.lights);
    view3D.updateDensity(vol, densitySliderToView3D(myState.density));
    view3D.updateExposure(myState.exposure);
  }
  showChannelUI(vol);

  return vol;
}

function onChannelDataArrived(v: Volume, channelIndex: number) {
  const currentVol = v; // myState.volume;

  // optionally can set the LUT here (for example if this is first time loading)

  view3D.onVolumeData(currentVol, [channelIndex]);
  view3D.setVolumeChannelEnabled(currentVol, channelIndex, myState.channelGui[channelIndex].enabled);

  view3D.updateActiveChannels(currentVol);
  view3D.updateLuts(currentVol);

  if (currentVol.isLoaded()) {
    console.log("currentVol with name " + currentVol.name + " is loaded");
  }
  updateChannelUI(currentVol, channelIndex);

  view3D.redraw();
}

function onVolumeCreated(name: string, volume: Volume) {
  const myJson = volume.imageInfo;
  myState.volume = volume;
  myState.currentImageName = name;

  view3D.removeAllVolumes();
  view3D.addVolume(myState.volume);
  setInitialRenderMode();

  view3D.updateActiveChannels(myState.volume);
  view3D.updateLuts(myState.volume);
  view3D.updateLights(myState.lights);
  view3D.updateDensity(myState.volume, densitySliderToView3D(myState.density));
  view3D.updateExposure(myState.exposure);

  // apply a volume transform from an external source:
  if (myJson.transform) {
    const alignTransform = myJson.imageInfo.transform;
    view3D.setVolumeTranslation(myState.volume, myState.volume.voxelsToWorldSpace(alignTransform.translation));
    view3D.setVolumeRotation(myState.volume, alignTransform.rotation);
    view3D.setVolumeScale(myState.volume, alignTransform.scale);
  }

  // hardcoded a special volume to know it's segmentation channel for pick testing
  if (name === "testpick") {
    view3D.enablePicking(myState.volume, true, 0);
  } else {
    view3D.enablePicking(myState.volume, false);
  }

  updateTimeUI();
  updateScenesUI();
  updateZSliceUI(myState.volume);
  showChannelUI(myState.volume);
}

function setSyncMultichannelLoading(sync: boolean) {
  myState.loader.forEach((loader) => loader.syncMultichannelLoading(sync));
}

function playTimeSeries(onNewFrameCallback: () => void) {
  window.clearTimeout(myState.timerId);
  setSyncMultichannelLoading(true);
  myState.isPlaying = true;

  const loadNextFrame = () => {
    myState.lastFrameTime = Date.now();
    const nextFrame = (myState.currentFrame + 1) % getNumberOfTimesteps();

    // TODO would be real nice if this were an `await`-able promise instead...
    view3D.setTime(myState.volume, nextFrame, (vol) => {
      if (vol.isLoaded()) {
        myState.currentFrame = nextFrame;
        onNewFrameCallback();

        if (myState.isPlaying) {
          const timeLoading = Date.now() - myState.lastFrameTime;
          myState.timerId = window.setTimeout(loadNextFrame, PLAYBACK_INTERVAL - timeLoading);
        }
      }
    });
  };

  loadNextFrame();
}

function getCurrentFrame() {
  return myState.currentFrame;
}

function goToFrame(targetFrame: number): boolean {
  console.log("going to Frame " + targetFrame);
  const outOfBounds = targetFrame > getNumberOfTimesteps() - 1 || targetFrame < 0;
  if (outOfBounds) {
    console.log(`frame ${targetFrame} out of bounds`);
    return false;
  }

  view3D.setTime(myState.volume, targetFrame);
  myState.currentFrame = targetFrame;
  return true;
}

function goToZSlice(slice: number): boolean {
  if (view3D.setZSlice(myState.volume, slice)) {
    const zSlider = document.getElementById("zSlider") as HTMLInputElement;
    const zInput = document.getElementById("zValue") as HTMLInputElement;
    zInput.value = `${slice}`;
    zSlider.value = `${slice}`;
    return true;
  } else {
    return false;
  }

  // update UI if successful
}

function createTestVolume(dtype: NumberType): RawArrayLoaderOptions {
  const sizeX = 64;
  const sizeY = 64;
  const sizeZ = 64;
  const imgData: RawArrayInfo = {
    name: "AICS-10_5_5",
    sizeX,
    sizeY,
    sizeZ,
    sizeC: 3,
    physicalPixelSize: [1, 1, 1],
    spatialUnit: "",
    channelNames: ["DRAQ5", "EGFP", "SEG_Memb"],
  };

  // generate some raw volume data
  const channelVolumes = [
    VolumeMaker.createSphere(sizeX, sizeY, sizeZ, 24),
    VolumeMaker.createTorus(sizeX, sizeY, sizeZ, 24, 8),
    VolumeMaker.createCone(sizeX, sizeY, sizeZ, 24, 24),
  ];
  const alldata = VolumeMaker.concatenateArrays(channelVolumes, dtype);
  return {
    metadata: imgData,
    data: {
      dtype: dtype,
      // [c,z,y,x]
      shape: [channelVolumes.length, sizeZ, sizeY, sizeX],
      // the bits (assumed uint8!!)
      buffer: new DataView(alldata.buffer),
    },
  };
}

async function createLoader(data: TestDataSpec): Promise<IVolumeLoader[]> {
  if (data.type === "opencell") {
    return [new OpenCellLoader()];
  }

  await loaderContext.onOpen();

  const options: Partial<CreateLoaderOptions> = {};
  // top level array: multiscene
  if (Array.isArray(data.url)) {
    // fake multiscene loading. TODO revert and replace with the real thing!
    const options = {
      fetchOptions: { maxPrefetchDistance: PREFETCH_DISTANCE, maxPrefetchChunks: MAX_PREFETCH_CHUNKS },
    };
    const promises = data.url.map((url) => loaderContext.createLoader(url, options));
    return Promise.all(promises);
  } else {
    // data.url is not an array
    let path: string | string[] = data.url;

    // treat json as single scene, assume single url source.
    if (data.type === VolumeFileFormat.JSON) {
      const src = data.url as string;
      const times = data.times || 0;
      const timesArray = [...Array(times + 1).keys()];
      path = timesArray.map((t) => src.replace("%%", t.toString()));
    } else if (data.type === VolumeFileFormat.DATA) {
      const volumeInfo = createTestVolume(data.dtype || "uint8");
      options.fileType = VolumeFileFormat.DATA;
      options.rawArrayOptions = { data: volumeInfo.data, metadata: volumeInfo.metadata };
    }

    const result = await loaderContext.createLoader(path, {
      ...options,
      fetchOptions: { maxPrefetchDistance: PREFETCH_DISTANCE, maxPrefetchChunks: MAX_PREFETCH_CHUNKS },
    });
    return [result];
  }
}

async function loadVolume(name: string, loadSpec: LoadSpec, loader: IVolumeLoader): Promise<void> {
  const fullDims = await loader.loadDims(loadSpec);
  console.log(fullDims);

  const volume = await loader.createVolume(loadSpec, onChannelDataArrived);
  onVolumeCreated(name, volume);
  loader.loadVolumeData(volume);

  // Set default slice index
  goToZSlice(Math.floor(volume.imageInfo.subregionSize.z / 2));
}

async function loadTestData(name: string, testdata: TestDataSpec) {
  myState.loader = await createLoader(testdata);

  const loadSpec = new LoadSpec();
  myState.totalFrames = testdata.times;
  const loader = myState.loader[Math.max(myState.scene, myState.loader.length - 1)];
  loadVolume(name, loadSpec, loader);
}

function gammaSliderToImageValues(sliderValues: [number, number, number]): [number, number, number] {
  let min = Number(sliderValues[0]);
  let mid = Number(sliderValues[1]);
  let max = Number(sliderValues[2]);

  if (mid > max || mid < min) {
    mid = 0.5 * (min + max);
  }
  const div = 255;
  min /= div;
  max /= div;
  mid /= div;
  const diff = max - min;
  const x = (mid - min) / diff;
  let scale = 4 * x * x;
  if ((mid - 0.5) * (mid - 0.5) < 0.0005) {
    scale = 1.0;
  }
  return [min, max, scale];
}

function getStateColorizeFeature(): ColorizeFeature | null {
  if (myState.colorizeEnabled) {
    const feature = colorizerfeatures[myState.feature];
    const colormap = colorizercolormaps[myState.colormap].tex;
    return {
      idsToFeatureValue: feature.featureTex,
      featureValueToColor: colormap,
      outlierData: feature.outlierData,
      inRangeIds: feature.inRangeIds,
      featureMin: myState.featureMin,
      featureMax: myState.featureMax,
      outlineColor: new Color(0xffffff),
      outlineAlpha: 1.0,
      outlierColor: new Color(0x444444),
      outlinePalette: colormap,
      innerOutlineColor: new Color(0x000000),
      innerOutlineThickness: 0.0,
      useOutlinePalette: false,
      outOfRangeColor: new Color(0x444444),
      outlierDrawMode: 0,
      outOfRangeDrawMode: 0,
      hideOutOfRange: false,
      frameToGlobalIdLookup: new Map(),
      useRepeatingColor: false,
    };
  } else {
    return null;
  }
}

function setupColorizeControls() {
  const colorizeButton = document.getElementById("colorize") as HTMLButtonElement;
  colorizeButton?.addEventListener("click", () => {
    myState.colorizeEnabled = !myState.colorizeEnabled;
    view3D.setChannelColorizeFeature(myState.volume, myState.colorizeChannel, getStateColorizeFeature());
  });

  const segChannelInput = document.getElementById("segchannel") as HTMLInputElement;
  segChannelInput?.addEventListener("change", () => {
    const channelIndex = Number(segChannelInput.value);
    myState.colorizeChannel = channelIndex;
    view3D.setChannelColorizeFeature(myState.volume, myState.colorizeChannel, getStateColorizeFeature());
  });

  const colormapInput = document.getElementById("colormap") as HTMLSelectElement;
  colormapInput?.addEventListener("change", () => {
    const colormap = colormapInput.value;
    myState.colormap = colormap;
    view3D.setChannelColorizeFeature(myState.volume, myState.colorizeChannel, getStateColorizeFeature());
  });

  const featureInput = document.getElementById("feature") as HTMLSelectElement;
  featureInput?.addEventListener("change", () => {
    const feature = featureInput.value;
    myState.feature = feature;
    view3D.setChannelColorizeFeature(myState.volume, myState.colorizeChannel, getStateColorizeFeature());
  });

  const featureMinInput = document.getElementById("featmin") as HTMLInputElement;
  featureMinInput?.addEventListener("change", () => {
    const featureMin = Number(featureMinInput.value) / 100.0;
    console.log("featureMin: " + featureMin);
    myState.featureMin = featureMin;
    view3D.setChannelColorizeFeature(myState.volume, myState.colorizeChannel, getStateColorizeFeature());
  });

  const featureMaxInput = document.getElementById("featmax") as HTMLInputElement;
  featureMaxInput?.addEventListener("change", () => {
    const featureMax = Number(featureMaxInput.value) / 100.0;
    console.log("featureMax: " + featureMax);
    myState.featureMax = featureMax;
    view3D.setChannelColorizeFeature(myState.volume, myState.colorizeChannel, getStateColorizeFeature());
  });
}

function main() {
  const el = document.getElementById("vol-e");
  if (!el) {
    return;
  }
  view3D = new View3d({ parentElement: el });

  el.addEventListener("mousemove", (e: Event) => {
    const event = e as MouseEvent;
    const intersectedObject = view3D.hitTest(event.offsetX, event.offsetY);
    if (intersectedObject !== -1) {
      el.style.cursor = "pointer";
      console.log("picked " + intersectedObject);
      view3D.setSelectedID(myState.volume, myState.colorizeChannel, intersectedObject);
    } else {
      el.style.cursor = "default";
      view3D.setSelectedID(myState.volume, myState.colorizeChannel, -1);
    }
  });

  const testDataSelect = document.getElementById("testData");
  testDataSelect?.addEventListener("change", ({ currentTarget }) => {
    const selected = (currentTarget as HTMLOptionElement)?.value;
    const testdata = TEST_DATA[selected];
    if (testdata) {
      loadTestData(selected, testdata);
    }
  });

  const xBtn = document.getElementById("X");
  xBtn?.addEventListener("click", () => {
    view3D.setCameraMode("X");
  });
  const yBtn = document.getElementById("Y");
  yBtn?.addEventListener("click", () => {
    view3D.setCameraMode("Y");
  });
  const zBtn = document.getElementById("Z");
  zBtn?.addEventListener("click", () => {
    view3D.setCameraMode("Z");
  });
  const d3Btn = document.getElementById("3D");
  d3Btn?.addEventListener("click", () => {
    view3D.setCameraMode("3D");
  });
  const tripleBtn = document.getElementById("tripleBtn");
  tripleBtn?.addEventListener("click", () => {
    view3D.setCameraMode("TRIPLE");
  });
  const rotBtn = document.getElementById("rotBtn");
  rotBtn?.addEventListener("click", () => {
    myState.isTurntable = !myState.isTurntable;
    view3D.setAutoRotate(myState.isTurntable);
  });
  const axisBtn = document.getElementById("axisBtn");
  axisBtn?.addEventListener("click", () => {
    myState.isAxisShowing = !myState.isAxisShowing;
    view3D.setShowAxis(myState.isAxisShowing);
  });
  const showBoundsBtn = document.getElementById("showBoundingBox");
  showBoundsBtn?.addEventListener("click", () => {
    myState.showBoundingBox = !myState.showBoundingBox;
    view3D.setShowBoundingBox(myState.volume, myState.showBoundingBox);
  });
  const showScaleBarBtn = document.getElementById("showScaleBar");
  showScaleBarBtn?.addEventListener("click", () => {
    myState.showScaleBar = !myState.showScaleBar;
    view3D.setShowScaleBar(myState.showScaleBar);
  });

  // convert value to rgb array
  function hexToRgb(hex, last: [number, number, number]): [number, number, number] {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
      ? [parseInt(result[1], 16) / 255.0, parseInt(result[2], 16) / 255.0, parseInt(result[3], 16) / 255.0]
      : last;
  }
  const boundsColorBtn = document.getElementById("boundingBoxColor");
  boundsColorBtn?.addEventListener("change", (event: Event) => {
    myState.boundingBoxColor = hexToRgb((event.target as HTMLInputElement)?.value, myState.boundingBoxColor);
    view3D.setBoundingBoxColor(myState.volume, myState.boundingBoxColor);
  });
  const backgroundColorBtn = document.getElementById("backgroundColor");
  backgroundColorBtn?.addEventListener("change", (event: Event) => {
    myState.backgroundColor = hexToRgb((event.target as HTMLInputElement)?.value, myState.backgroundColor);
    view3D.setBackgroundColor(myState.backgroundColor);
  });

  const flipXBtn = document.getElementById("flipXBtn");
  flipXBtn?.addEventListener("click", () => {
    myState.flipX *= -1;
    view3D.setFlipVolume(myState.volume, myState.flipX as -1 | 1, myState.flipY, myState.flipZ);
  });
  const flipYBtn = document.getElementById("flipYBtn");
  flipYBtn?.addEventListener("click", () => {
    myState.flipY *= -1;
    view3D.setFlipVolume(myState.volume, myState.flipX, myState.flipY as -1 | 1, myState.flipZ);
  });
  const flipZBtn = document.getElementById("flipZBtn");
  flipZBtn?.addEventListener("click", () => {
    myState.flipZ *= -1;
    view3D.setFlipVolume(myState.volume, myState.flipX, myState.flipY, myState.flipZ as -1 | 1);
  });
  const playBtn = document.getElementById("playBtn");
  playBtn?.addEventListener("click", () => {
    if (myState.currentFrame >= getNumberOfTimesteps() - 1) {
      myState.currentFrame = -1;
    }
    playTimeSeries(() => {
      if (timeInput) {
        timeInput.value = "" + getCurrentFrame();
      }
      if (timeSlider) {
        timeSlider.value = "" + getCurrentFrame();
      }
    });
  });
  const pauseBtn = document.getElementById("pauseBtn");
  pauseBtn?.addEventListener("click", () => {
    window.clearTimeout(myState.timerId);
    myState.isPlaying = false;
    setSyncMultichannelLoading(false);
  });

  const forwardBtn = document.getElementById("forwardBtn");
  const backBtn = document.getElementById("backBtn");
  const timeSlider = document.getElementById("timeSlider") as HTMLInputElement;
  const timeInput = document.getElementById("timeValue") as HTMLInputElement;
  const sceneInput = document.getElementById("sceneValue") as HTMLInputElement;
  forwardBtn?.addEventListener("click", () => {
    if (goToFrame(getCurrentFrame() + 1)) {
      if (timeInput) {
        timeInput.value = "" + getCurrentFrame();
      }
      if (timeSlider) {
        timeSlider.value = "" + getCurrentFrame();
      }
    }
  });
  backBtn?.addEventListener("click", () => {
    if (goToFrame(getCurrentFrame() - 1)) {
      if (timeInput) {
        timeInput.value = "" + getCurrentFrame();
      }
      if (timeSlider) {
        timeSlider.value = "" + getCurrentFrame();
      }
    }
  });
  // only update when DONE sliding: change event
  timeSlider?.addEventListener("change", () => {
    // trigger loading new time
    if (goToFrame(timeSlider?.valueAsNumber)) {
      if (timeInput) {
        timeInput.value = timeSlider.value;
      }
    }
  });
  timeInput?.addEventListener("change", () => {
    // trigger loading new time
    if (goToFrame(timeInput?.valueAsNumber)) {
      // update slider
      if (timeSlider) {
        timeSlider.value = timeInput.value;
      }
    }
  });
  sceneInput?.addEventListener("change", () => {
    if (myState.loader.length > 1 && myState.scene !== sceneInput.valueAsNumber) {
      myState.scene = sceneInput.valueAsNumber;
      loadVolume(myState.currentImageName, new LoadSpec(), myState.loader[myState.scene]);
    }
  });

  // Set up Z-slice UI
  const zforwardBtn = document.getElementById("zforwardBtn");
  const zbackBtn = document.getElementById("zbackBtn");
  const zSlider = document.getElementById("zSlider") as HTMLInputElement;
  const zInput = document.getElementById("zValue") as HTMLInputElement;
  zforwardBtn?.addEventListener("click", () => {
    goToZSlice(zSlider?.valueAsNumber + 1);
  });
  zbackBtn?.addEventListener("click", () => {
    goToZSlice(zSlider?.valueAsNumber - 1);
  });
  zSlider?.addEventListener("change", () => {
    goToZSlice(zSlider?.valueAsNumber);
  });
  zInput?.addEventListener("change", () => {
    goToZSlice(zInput?.valueAsNumber);
  });

  const alignBtn = document.getElementById("xfBtn");
  alignBtn?.addEventListener("click", () => {
    myState.isAligned = !myState.isAligned;
    view3D.setVolumeTranslation(myState.volume, myState.isAligned ? myState.volume.getTranslation() : [0, 0, 0]);
    view3D.setVolumeRotation(myState.volume, myState.isAligned ? myState.volume.getRotation() : [0, 0, 0]);
  });
  const resetCamBtn = document.getElementById("resetCamBtn");
  resetCamBtn?.addEventListener("click", () => {
    view3D.resetCamera();
  });
  const counterSpan = document.getElementById("counter");
  if (counterSpan) {
    view3D.addEventListener("renderIteration", ({ iteration }) => {
      counterSpan.textContent = String(iteration);
    });
  }

  const renderModeSelect = document.getElementById("renderMode");
  const changeRenderMode = (pt: boolean, mp: boolean) => {
    myState.isPT = pt;
    myState.isMP = mp;
    view3D.setVolumeRenderMode(pt ? RENDERMODE_PATHTRACE : RENDERMODE_RAYMARCH);
    view3D.setMaxProjectMode(myState.volume, mp);
  };
  renderModeSelect?.addEventListener("change", ({ currentTarget }) => {
    const target = (currentTarget as HTMLOptionElement)!;
    if (target.value === "PT") {
      if (view3D.hasWebGL2()) {
        changeRenderMode(true, false);
      }
    } else if (target.value === "MP") {
      changeRenderMode(false, true);
    } else {
      changeRenderMode(false, false);
    }
  });

  const interpolateBtn = document.getElementById("interpolateBtn");
  interpolateBtn?.addEventListener("click", () => {
    myState.interpolationActive = !myState.interpolationActive;
    view3D.setInterpolationEnabled(myState.volume, myState.interpolationActive);
  });

  const screenshotBtn = document.getElementById("screenshotBtn");
  screenshotBtn?.addEventListener("click", () => {
    view3D.capture((dataUrl) => {
      const anchor = document.createElement("a");
      anchor.href = dataUrl;
      anchor.download = "screenshot.png";
      anchor.click();
    });
  });

  const gammaMin = document.getElementById("gammaMin") as HTMLInputElement;
  const gammaMax = document.getElementById("gammaMax") as HTMLInputElement;
  const gammaScale = document.getElementById("gammaScale") as HTMLInputElement;
  gammaMin?.addEventListener("change", ({ currentTarget }) => {
    const g = gammaSliderToImageValues([gammaMin.valueAsNumber, gammaScale.valueAsNumber, gammaMax.valueAsNumber]);
    view3D.setGamma(myState.volume, g[0], g[1], g[2]);
  });
  gammaMin?.addEventListener("input", ({ currentTarget }) => {
    const g = gammaSliderToImageValues([gammaMin.valueAsNumber, gammaScale.valueAsNumber, gammaMax.valueAsNumber]);
    view3D.setGamma(myState.volume, g[0], g[1], g[2]);
  });
  gammaMax?.addEventListener("change", ({ currentTarget }) => {
    const g = gammaSliderToImageValues([gammaMin.valueAsNumber, gammaScale.valueAsNumber, gammaMax.valueAsNumber]);
    view3D.setGamma(myState.volume, g[0], g[1], g[2]);
  });
  gammaMax?.addEventListener("input", ({ currentTarget }) => {
    const g = gammaSliderToImageValues([gammaMin.valueAsNumber, gammaScale.valueAsNumber, gammaMax.valueAsNumber]);
    view3D.setGamma(myState.volume, g[0], g[1], g[2]);
  });
  gammaScale?.addEventListener("change", ({ currentTarget }) => {
    const g = gammaSliderToImageValues([gammaMin.valueAsNumber, gammaScale.valueAsNumber, gammaMax.valueAsNumber]);
    view3D.setGamma(myState.volume, g[0], g[1], g[2]);
  });
  gammaScale?.addEventListener("input", ({ currentTarget }) => {
    const g = gammaSliderToImageValues([gammaMin.valueAsNumber, gammaScale.valueAsNumber, gammaMax.valueAsNumber]);
    view3D.setGamma(myState.volume, g[0], g[1], g[2]);
  });

  setupColorizeControls();
  setupGui();

  loadTestData((testDataSelect as HTMLSelectElement)?.value, TEST_DATA[(testDataSelect as HTMLSelectElement)?.value]);
}

document.body.onload = () => {
  main();
};
