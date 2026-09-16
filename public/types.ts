import { Volume, Light } from "../src/index.js";
import { VolumeFileFormat } from "../src/loaders/index.js";
import { VolumeLoader } from "../src/loaders/IVolumeLoader.js";
import type { NumberType } from "../src/types.js";

export interface TestDataSpec {
  type: VolumeFileFormat | "opencell";
  // TODO: replace array here with multi-scene handling at the loader level
  // one string is single scene
  // an array of strings is multiple scenes
  // (currently for tiff only) an array of arrays is multiple scenes with multiple channel sources
  url: string | string[] | string[][];
  /** Optional fallback for JSON volumes which don't specify a value for `times` */
  times?: number;
  /** data type for procedural only */
  dtype?: NumberType;
}

export interface State {
  file: string;
  volume: Volume;
  totalFrames?: number;
  currentFrame: number;
  lastFrameTime: number;
  isPlaying: boolean;
  timerId: number;
  scene: number;

  loader: VolumeLoader[];

  density: number;
  maskAlpha: number;
  exposure: number;
  aperture: number;
  fov: number;
  focalDistance: number;

  lights: Light[];

  skyTopIntensity: number;
  skyMidIntensity: number;
  skyBotIntensity: number;
  skyTopColor: [number, number, number];
  skyMidColor: [number, number, number];
  skyBotColor: [number, number, number];

  lightColor: [number, number, number];
  lightIntensity: number;
  lightTheta: number;
  lightPhi: number;

  xmin: number;
  ymin: number;
  zmin: number;
  xmax: number;
  ymax: number;
  zmax: number;

  samplingRate: number;
  primaryRay: number;
  secondaryRay: number;

  isPT: boolean;
  isMP: boolean;
  interpolationActive: boolean;

  isTurntable: boolean;
  isAxisShowing: boolean;
  isAligned: boolean;

  showScaleBar: boolean;

  showBoundingBox: boolean;
  boundingBoxColor: [number, number, number];

  backgroundColor: [number, number, number];

  flipX: -1 | 1;
  flipY: -1 | 1;
  flipZ: -1 | 1;

  channelFolderNames: string[];
  channelGui: ChannelGuiOptions[];

  currentImageStore: string;
  currentImageName: string;

  colorizeEnabled: boolean;
  colorizeChannel: number;
  colormap: string;
  feature: string;
  featureMin: number;
  featureMax: number;
}

interface ChannelGuiOptions {
  colorD: [number, number, number];
  colorS: [number, number, number];
  colorE: [number, number, number];
  window: number;
  level: number;
  glossiness: number;
  isovalue: number;
  isosurface: boolean;
  enabled: boolean;
  reset: (channelNum: number) => void;
  autoIJ: (channelNum: number) => void;
  auto0: (channelNum: number) => void;
  bestFit: (channelNum: number) => void;
  // eslint-disable-next-line @typescript-eslint/naming-convention
  pct50_98: (channelNum: number) => void;
  colorizeEnabled: boolean;
  colorize: (channelNum: number) => void;
  colorizeAlpha: number;
}
