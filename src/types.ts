import { Camera, Color, DataTexture, OrthographicCamera, PerspectiveCamera, Vector3 } from "three";

export interface Bounds {
  bmin: Vector3;
  bmax: Vector3;
}

// this enum represents all allowed viewing modes in Vol-E.
export enum Axis {
  X = "x",
  Y = "y",
  Z = "z",
  /** Alias for NONE, indicates 3D mode */
  XYZ = "",
  /** No current axis, indicates 3D mode */
  // eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
  NONE = "",
  /** Triple orthographic slice view (XY + YZ + XZ) */
  TRIPLE = "triple",
}

/** Name of a single spatial axis: `"x"`, `"y"`, or `"z"`. */
export type AxisName = Axis.X | Axis.Y | Axis.Z;

/** Rectangle of a single triple-slice pane, in CSS pixels. */
export type TripleViewPaneRect = { x: number; y: number; w: number; h: number };

/** The three pane rectangles that make up the triple-slice view. */
export type TripleViewPanes = {
  /** XY slice (bottom-left) */
  xy: TripleViewPaneRect;
  /** YZ slice (bottom-right) */
  yz: TripleViewPaneRect;
  /** XZ slice (top-left) */
  xz: TripleViewPaneRect;
};

// numeric types compatible with zarrita.js.
// see https://github.com/manzt/zarrita.js/blob/main/packages/core/src/metadata.ts
export type Int8 = "int8";
export type Int16 = "int16";
export type Int32 = "int32";
export type Int64 = "int64";
export type Uint8 = "uint8";
export type Uint16 = "uint16";
export type Uint32 = "uint32";
export type Uint64 = "uint64";
export type Float32 = "float32";
export type Float64 = "float64";
export type NumberType = Int8 | Int16 | Int32 | Uint8 | Uint16 | Uint32 | Float32 | Float64;
// prettier-ignore
export type TypedArray<D extends NumberType = NumberType, B extends ArrayBufferLike = ArrayBuffer> =
  D extends Int8
  ? Int8Array<B>
  : D extends Int16
  ? Int16Array<B>
  : D extends Int32
  ? Int32Array<B>
  : D extends Int64
  ? BigInt64Array<B>
  : D extends Uint8
  ? Uint8Array<B>
  : D extends Uint16
  ? Uint16Array<B>
  : D extends Uint32
  ? Uint32Array<B>
  : D extends Uint64
  ? BigUint64Array<B>
  : D extends Float32
  ? Float32Array<B>
  : D extends Float64
  ? Float64Array<B>
  : never;

export const ARRAY_CONSTRUCTORS = {
  int8: Int8Array,
  int16: Int16Array,
  int32: Int32Array,
  int64: globalThis.BigInt64Array,
  uint8: Uint8Array,
  uint16: Uint16Array,
  uint32: Uint32Array,
  uint64: globalThis.BigUint64Array,
  float32: Float32Array,
  float64: Float64Array,
};

export function isFloatTypeArray<B extends ArrayBufferLike>(
  array: TypedArray<NumberType, B>
): array is Float32Array<B> | Float64Array<B> {
  return array instanceof Float32Array || array instanceof Float64Array;
}

export interface ColorizeFeature {
  idsToFeatureValue: DataTexture;
  featureValueToColor: DataTexture;
  /**
   * Ignore the feature min and max, and treat the color ramp texture as a
   * direct lookup for feature values. Feature values that are greater than
   * the length of the color ramp will be wrapped around to the start
   * (e.g. `value % colorRamp.length`).
   */
  useRepeatingColor: boolean;
  /**
   * Maps from a frame number to an info object used to look up the global ID
   * from a given segmentation ID (raw pixel value) on that frame. The info
   * object contains a texture and a minimum segmentation ID for that frame, the
   * latter of which is used to minimize the memory footprint of the lookup
   * table.
   *
   * For a frame at time `t`, the global ID of a segmentation `segId` is given
   * by:
   * ```
   * lookup[t].texture.getAt(segId - lookup[t].minSegId) - 1
   * ```
   * The result is `-1` if there is no global ID for that segmentation ID on
   * that frame.
   *
   * The global ID can be used directly as an index into the
   * `idsToFeatureValue`, `inRangeIds`, and `outlierData` data textures to get
   * values for that segmentation ID.
   */
  frameToGlobalIdLookup: Map<number, { texture: DataTexture; minSegId: number }>;
  inRangeIds: DataTexture;
  outlierData: DataTexture;
  featureMin: number;
  featureMax: number;
  outlineColor: Color;
  outlinePalette: DataTexture;
  useOutlinePalette: boolean;
  innerOutlineColor: Color;
  innerOutlineThickness: number;
  outlineAlpha: number;
  outlierColor: Color;
  outOfRangeColor: Color;
  outlierDrawMode: number;
  outOfRangeDrawMode: number;
  hideOutOfRange: boolean;
}

export interface FuseChannel {
  chIndex: number;
  lut: Uint8Array;
  // zero is a sentinel value to disable from fusion
  rgbColor: [number, number, number] | number;
  // if we are colorizing by feature, all the following inputs are needed
  feature?: ColorizeFeature;
}

/** If `FuseChannel.rgbColor` is this value, it is disabled from fusion. */
export const FUSE_DISABLED_RGB_COLOR = 0;

export interface VolumeChannelDisplayOptions {
  /** Whether the channel's volume data should be rendered for this channel. */
  enabled?: boolean;
  /** RGB color array, with values in the range of [0, 255]. */
  color?: [number, number, number];
  /** RGB color array for specular (highlight) color, with values in the range of [0, 255]. */
  specularColor?: [number, number, number];
  /** RGB color array for emissive (glow) color, with values in the range of [0, 255]. */
  emissiveColor?: [number, number, number];
  /** Exponent factor controlling the glossiness ("shininess") of the material. 0 is default. */
  glossiness?: number;
  /** Whether the isosurface mesh should be rendered for this channel. */
  isosurfaceEnabled?: boolean;
  /**
   * Isovalue used to calculate the isosurface mesh, in a [0, 255] range.
   * Isosurface is found at the set of all boundaries between voxels whose
   * intensities span across this isovalue.
   */
  isovalue?: number;
  /** Opacity of the isosurface, in a [0, 1] range. */
  isosurfaceOpacity?: number;
}

export enum RenderMode {
  RAYMARCH = 0,
  PATHTRACE = 1,
  SLICE = 2,
  TRIPLE_SLICE = 3,
}

/**
 * Provide options to control the visual appearance of a Volume
 * @typedef {Object} VolumeDisplayOptions
 * @property {Array.<VolumeChannelDisplayOptions>} channels array of channel display options
 * @property {number} density
 * @property {Array.<number>} translation xyz
 * @property {Array.<number>} rotation xyz angles in radians
 * @property {number} maskChannelIndex
 * @property {number} maskAlpha
 * @property {Array.<number>} clipBounds [xmin, xmax, ymin, ymax, zmin, zmax] all range from 0 to 1 as a percentage of the volume on that axis
 * @property {Array.<number>} scale xyz voxel size scaling
 * @property {boolean} maxProjection true or false (ray marching)
 * @property {number} renderMode 0 for raymarch, 1 for pathtrace
 * @property {number} shadingMethod 0 for phase, 1 for brdf, 2 for hybrid (path tracer)
 * @property {Array.<number>} gamma [min, max, scale]
 * @property {number} primaryRayStepSize in voxels
 * @property {number} secondaryRayStepSize in voxels
 * @property {boolean} showBoundingBox true or false
 * @property {Array.<number>} boundingBoxColor r,g,b for bounding box lines
 * @example let options = {
   };
 */
export interface VolumeDisplayOptions {
  channels?: VolumeChannelDisplayOptions[];
  density?: number;
  translation?: [number, number, number];
  rotation?: [number, number, number];
  maskChannelIndex?: number;
  maskAlpha?: number;
  clipBounds?: [number, number, number, number, number, number];
  maxProjection?: boolean;
  renderMode?: RenderMode;
  shadingMethod?: number;
  gamma?: [number, number, number];
  primaryRayStepSize?: number;
  secondaryRayStepSize?: number;
  showBoundingBox?: boolean;
  boundingBoxColor?: [number, number, number];
}

export const isOrthographicCamera = (def: Camera): def is OrthographicCamera =>
  def && (def as OrthographicCamera).isOrthographicCamera;

export const isPerspectiveCamera = (def: Camera): def is PerspectiveCamera =>
  def && (def as PerspectiveCamera).isPerspectiveCamera;

export const enum ViewportCorner {
  TOP_LEFT = "top_left",
  TOP_RIGHT = "top_right",
  BOTTOM_LEFT = "bottom_left",
  BOTTOM_RIGHT = "bottom_right",
}
export const isTop = (corner: ViewportCorner): boolean =>
  corner === ViewportCorner.TOP_LEFT || corner === ViewportCorner.TOP_RIGHT;
export const isRight = (corner: ViewportCorner): boolean =>
  corner === ViewportCorner.TOP_RIGHT || corner === ViewportCorner.BOTTOM_RIGHT;

export const DATARANGE_UINT8: [number, number] = [0, 255];
