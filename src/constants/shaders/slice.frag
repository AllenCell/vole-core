
#ifdef GL_ES
precision highp float;
#endif

uniform vec2 textureRes;
uniform float GAMMA_MIN;
uniform float GAMMA_MAX;
uniform float GAMMA_SCALE;
uniform float BRIGHTNESS;
uniform float DENSITY;
uniform float maskAlpha;
uniform vec2 ATLAS_DIMS;
uniform vec3 AABB_CLIP_MIN;
uniform vec3 AABB_CLIP_MAX;
uniform sampler2D textureAtlas;
uniform sampler2D textureAtlasMask;
uniform int SLICE_INDEX;
uniform float SLICES;
uniform bool interpolationEnabled;
uniform vec3 flipVolume;
#define VIEW_AXIS_Z 0
#define VIEW_AXIS_X 1
#define VIEW_AXIS_Y 2
uniform int viewAxis;
// in voxels
uniform vec3 volumeSize;

varying vec2 vUv;

// for atlased texture, we need to find the uv offset for the slice at t
vec2 offsetFrontBack(float t) {
  int a = int(t);
  int ax = int(ATLAS_DIMS.x);
  vec2 os = vec2(float(a - (a / ax) * ax), float(a / ax)) / ATLAS_DIMS;
  return clamp(os, vec2(0.0), vec2(1.0) - vec2(1.0) / ATLAS_DIMS);
}

vec4 sampleAtlas(sampler2D tex, vec4 pos) {
  float bounds = float(pos[0] >= 0.0 && pos[0] <= 1.0 && pos[1] >= 0.0 &&
                       pos[1] <= 1.0 && pos[2] >= 0.0 && pos[2] <= 1.0);

  float nSlices = float(SLICES);

  vec2 loc0 = ((pos.xy - 0.5) * flipVolume.xy + 0.5) / ATLAS_DIMS;

  if (interpolationEnabled) {
    // loc ranges from 0 to 1/ATLAS_DIMS
    // shrink loc0 to within one half edge texel - so as not to sample across
    // edges of tiles.
    loc0 = loc0 * (vec2(1.0) - ATLAS_DIMS / textureRes);
  } else {
    // No interpolation - sample just one slice at a pixel center.
    loc0 = floor(loc0 * textureRes) / textureRes;
  }
  loc0 += vec2(0.5) / textureRes;

  float z = min(floor(pos.z * nSlices), nSlices - 1.0);

  if (flipVolume.z == -1.0) {
    z = nSlices - z - 1.0;
  }

  vec2 o = offsetFrontBack(z) + loc0;
  vec4 voxelColor = texture2D(tex, o);

  // Apply mask
  float voxelMask = texture2D(textureAtlasMask, o).x;
  voxelMask = mix(voxelMask, 1.0, maskAlpha);
  voxelColor.rgb *= voxelMask;

  return bounds * voxelColor;
}

void main() {
  gl_FragColor = vec4(0.0);

  vec3 boxMin = AABB_CLIP_MIN;
  vec3 boxMax = AABB_CLIP_MAX;
  // Normalize UV for [-0.5, 0.5] range
  vec2 normUv = vUv - vec2(0.5);

  // Determine which pair of clip axes to check based on viewAxis
  vec2 clipMin2, clipMax2;
  if (viewAxis == VIEW_AXIS_X) {
    // YZ view: UV.x -> Z, UV.y -> Y (Y vertical to align with XY pane)
    clipMin2 = vec2(boxMin.z, boxMin.y);
    clipMax2 = vec2(boxMax.z, boxMax.y);
  } else if (viewAxis == VIEW_AXIS_Y) {
    // XZ view: UV.x -> X, UV.y -> Z
    clipMin2 = vec2(boxMin.x, boxMin.z);
    clipMax2 = vec2(boxMax.x, boxMax.z);
  } else {
    // XY view (default): UV.x -> X, UV.y -> Y
    clipMin2 = vec2(boxMin.x, boxMin.y);
    clipMax2 = vec2(boxMax.x, boxMax.y);
  }

  // Return background color if outside of clipping box
  if (normUv.x < clipMin2.x || normUv.x > clipMax2.x || normUv.y < clipMin2.y ||
      normUv.y > clipMax2.y) {
    gl_FragColor = vec4(0.0);
    return;
  }

  // Compute the normalized slice coordinate
  float sliceNorm =
      (SLICES == 1.0 && SLICE_INDEX == 0) ? 0.0 : float(SLICE_INDEX) / (SLICES - 1.0);

  // Build the 3D sample position based on viewAxis
  vec4 pos;
  if (viewAxis == VIEW_AXIS_X) {
    // YZ view: UV.x -> Z, UV.y -> Y, slice along X (Y vertical to align with XY
    // pane) SLICE_INDEX is an X voxel index; normalize by volumeSize.x
    float xNorm =
        (volumeSize.x <= 1.0) ? 0.0 : float(SLICE_INDEX) / (volumeSize.x - 1.0);
    pos = vec4(xNorm, vUv.y, vUv.x, 0.0);
  } else if (viewAxis == VIEW_AXIS_Y) {
    // XZ view: UV.x -> X, UV.y -> Z, slice along Y
    // SLICE_INDEX is a Y voxel index; normalize by volumeSize.y
    float yNorm =
        (volumeSize.y <= 1.0) ? 0.0 : float(SLICE_INDEX) / (volumeSize.y - 1.0);
    pos = vec4(vUv.x, yNorm, vUv.y, 0.0);
  } else {
    // XY view (default): UV -> XY, slice along Z
    pos = vec4(vUv, sliceNorm, 0.0);
  }

  vec4 C;
  C = sampleAtlas(textureAtlas, pos);
  C.xyz *= BRIGHTNESS;

  C = clamp(C, 0.0, 1.0);
  gl_FragColor = C;
  return;
}