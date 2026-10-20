
#ifdef GL_ES
precision highp float;
#endif

#define M_PI 3.14159265358979323846

uniform vec2 iResolution;
uniform vec2 textureRes;
uniform float GAMMA_MIN;
uniform float GAMMA_MAX;
uniform float GAMMA_SCALE;
uniform float BRIGHTNESS;
uniform float DENSITY;
uniform float maskAlpha;
uniform vec2 ATLAS_DIMS;
uniform vec3 AABB_CLIP_MIN;
uniform float CLIP_NEAR;
uniform vec3 AABB_CLIP_MAX;
uniform float CLIP_FAR;
uniform sampler2D textureAtlas;
uniform sampler2D textureAtlasMask;
uniform sampler2D textureDepth;
uniform int usingPositionTexture;
uniform int BREAK_STEPS;
uniform float SLICES;
uniform float isOrtho;
uniform float orthoThickness;
uniform float orthoScale;
uniform int maxProject;
uniform bool interpolationEnabled;
uniform vec3 flipVolume;
uniform vec3 volumeScale;

// view space to axis-aligned volume box
uniform mat4 inverseModelViewMatrix;
uniform mat4 inverseProjMatrix;

varying vec3 pObj;

float powf(float a, float b) {
  return pow(a, b);
}

float rand(vec2 co) {
  float threadId = gl_FragCoord.x / (gl_FragCoord.y + 1.0);
  float bigVal = threadId * 1299721.0 / 911.0;
  vec2 smallVal = vec2(threadId * 7927.0 / 577.0, threadId * 104743.0 / 1039.0);
  return fract(sin(dot(co, smallVal)) * bigVal);
}

vec4 luma2Alpha(vec4 color, float vmin, float vmax, float C) {
  float x = dot(color.rgb, vec3(0.2125, 0.7154, 0.0721));
  // float x = max(color[2], max(color[0],color[1]));
  float xi = (x - vmin) / (vmax - vmin);
  xi = clamp(xi, 0.0, 1.0);
  float y = pow(xi, C);
  y = clamp(y, 0.0, 1.0);
  color[3] = y;
  return color;
}

vec2 offsetFrontBack(float t) {
  int a = int(t);
  int ax = int(ATLAS_DIMS.x);
  vec2 os = vec2(float(a - (a / ax) * ax), float(a / ax)) / ATLAS_DIMS;
  return clamp(os, vec2(0.0), vec2(1.0) - vec2(1.0) / ATLAS_DIMS);
}

vec4 sampleAtlasLinear(sampler2D tex, vec4 pos) {
  float bounds = float(pos[0] >= 0.0 && pos[0] <= 1.0 &&
    pos[1] >= 0.0 && pos[1] <= 1.0 &&
    pos[2] >= 0.0 && pos[2] <= 1.0);
  float nSlices = float(SLICES);
  // get location within atlas tile
  // TODO: get loc1 which follows ray to next slice along ray direction
  // when flipvolume = 1:  pos
  // when flipvolume = -1: 1-pos
  vec2 loc0 = ((pos.xy - 0.5) * flipVolume.xy + 0.5) / ATLAS_DIMS;

  // loc ranges from 0 to 1/ATLAS_DIMS
  // shrink loc0 to within one half edge texel - so as not to sample across edges of tiles.
  loc0 = vec2(0.5) / textureRes + loc0 * (vec2(1.0) - ATLAS_DIMS / textureRes);

  // interpolate between two slices
  float z = (pos.z) * (nSlices - 1.0);
  float z0 = floor(z);
  float t = z - z0; //mod(z, 1.0);
  float z1 = min(z0 + 1.0, nSlices - 1.0);

  // flipped:
  if (flipVolume.z == -1.0) {
    z0 = nSlices - z0 - 1.0;
    z1 = nSlices - z1 - 1.0;
    t = 1.0 - t;
  }

  // get slice offsets in texture atlas
  vec2 o0 = offsetFrontBack(z0) + loc0;
  vec2 o1 = offsetFrontBack(z1) + loc0;

  vec4 slice0Color = texture2D(tex, o0);
  vec4 slice1Color = texture2D(tex, o1);
  // NOTE we could premultiply the mask in the fuse function,
  // but that is slower to update the maskAlpha value than here in the shader.
  // it is a memory vs perf tradeoff.  Do users really need to update the maskAlpha at realtime speed?
  float slice0Mask = texture2D(textureAtlasMask, o0).x;
  float slice1Mask = texture2D(textureAtlasMask, o1).x;
  // or use max for conservative 0 or 1 masking?
  float maskVal = mix(slice0Mask, slice1Mask, t);
  // take mask from 0..1 to alpha..1
  maskVal = mix(maskVal, 1.0, maskAlpha);
  vec4 retval = mix(slice0Color, slice1Color, t);
  // only mask the rgb, not the alpha(?)
  retval.rgb *= maskVal;
  return bounds * retval;
}

vec4 sampleAtlasNearest(sampler2D tex, vec4 pos) {
  float bounds = float(pos[0] >= 0.0 && pos[0] <= 1.0 &&
    pos[1] >= 0.0 && pos[1] <= 1.0 &&
    pos[2] >= 0.0 && pos[2] <= 1.0);
  float nSlices = float(SLICES);

  vec2 loc0 = ((pos.xy - 0.5) * flipVolume.xy + 0.5) / ATLAS_DIMS;

  // No interpolation - sample just one slice at a pixel center.
  // Ideally this would be accomplished in part by switching this texture to linear
  //   filtering, but three makes this difficult to do through a WebGLRenderTarget.
  loc0 = floor(loc0 * textureRes) / textureRes;
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

bool intersectBox(
  in vec3 r_o,
  in vec3 r_d,
  in vec3 boxMin,
  in vec3 boxMax,
  out float tnear,
  out float tfar
) {
  // compute intersection of ray with all six bbox planes
  vec3 invR = vec3(1.0, 1.0, 1.0) / r_d;
  vec3 tbot = invR * (boxMin - r_o);
  vec3 ttop = invR * (boxMax - r_o);

  // re-order intersections to find smallest and largest on each axis
  vec3 tmin = min(ttop, tbot);
  vec3 tmax = max(ttop, tbot);

  // find the largest tmin and the smallest tmax
  float largest_tmin = max(max(tmin.x, tmin.y), tmin.z);
  float smallest_tmax = min(min(tmax.x, tmax.y), tmax.z);

  tnear = largest_tmin;
  tfar = smallest_tmax;

  // use >= here?
  return (smallest_tmax > largest_tmin);
}

vec4 accumulate(vec4 col, float s, vec4 C) {
  float stepScale = (1.0 - powf((1.0 - col.w), s));
  col.w = stepScale;
  col.xyz *= col.w;
  col = clamp(col, 0.0, 1.0);

  C = (1.0 - C.w) * col + C;
  return C;
}

vec4 integrateVolume(
  vec4 eye_o,
  vec4 eye_d,
  float tnear,
  float tfar,
  float clipNear,
  float clipFar,
  sampler2D textureAtlas
) {
  vec4 C = vec4(0.0);
  // march along ray from front to back, accumulating color

  // estimate step length
  const int maxSteps = 512;
  // modify the 3 components of eye_d by volume scale
  float scaledSteps = float(BREAK_STEPS) * length((eye_d.xyz / volumeScale));
  float csteps = clamp(float(scaledSteps), 1.0, float(maxSteps));
  float invstep = (tfar - tnear) / csteps;
  // special-casing the single slice to remove the random ray dither.
  // this removes a Moire pattern visible in single slice images, which we want to view as 2D images as best we can.
  float r = (SLICES == 1.0) ? 0.0 : rand(eye_d.xy);
  // if ortho and clipped, make step size smaller so we still get same number of steps
  float tstep = invstep * orthoThickness;
  float tfarsurf = r * tstep;
  float overflow = mod((tfarsurf - tfar), tstep); // random dithering offset
  float t = tnear + overflow;
  t += r * tstep; // random dithering offset
  float tdist = 0.0;
  int numSteps = 0;
  vec4 pos, col;
  // We need to be able to scale the alpha contrib with number of ray steps,
  // in order to make the final color invariant to the step size(?)
  // use maxSteps (a constant) as the numerator... Not sure if this is sound.
  float s = 0.5 * float(maxSteps) / csteps;
  for (int i = 0; i < maxSteps; i++) {
    pos = eye_o + eye_d * t;
    // !!! assume box bounds are -0.5 .. 0.5.  pos = (pos-min)/(max-min)
    // scaling is handled by model transform and already accounted for before we get here.
    // AABB clip is independent of this and is only used to determine tnear and tfar.
    pos.xyz = (pos.xyz - (-0.5)) / ((0.5) - (-0.5)); //0.5 * (pos + 1.0); // map position from [boxMin, boxMax] to [0, 1] coordinates

    vec4 col = interpolationEnabled ? sampleAtlasLinear(textureAtlas, pos) : sampleAtlasNearest(textureAtlas, pos);

    if (maxProject != 0) {
      col.xyz *= BRIGHTNESS;
      C = max(col, C);
    } else {
      // Note: Regular volume channels have an alpha of 0, and use luminance to
      // vary 
      if (col.a < 0.000001) {
        col = luma2Alpha(col, GAMMA_MIN, GAMMA_MAX, GAMMA_SCALE);
      }
      col.xyz *= BRIGHTNESS;
      // for practical use the density only matters for regular volume integration
      col.w *= DENSITY;
      C = accumulate(col, s, C);
    }
    t += tstep;
    numSteps = i;

    if (t > tfar || t > tnear + clipFar)
      break;
    if (C.w > 1.0)
      break;
  }

  return C;
}

void main() {
  gl_FragColor = vec4(0.0);
  vec2 vUv = gl_FragCoord.xy / iResolution.xy;

  vec3 eyeRay_o, eyeRay_d;

  if (isOrtho == 0.0) {
    // for perspective rays:
    // world space camera coordinates
    // transform to object space
    eyeRay_o = (inverseModelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    eyeRay_d = normalize(pObj - eyeRay_o);
  } else {
    // for ortho rays:
    float zDist = 2.0;
    eyeRay_d = (inverseModelViewMatrix * vec4(0.0, 0.0, -zDist, 0.0)).xyz;
    vec4 ray_o = vec4(2.0 * vUv - 1.0, 1.0, 1.0);
    ray_o.xy *= orthoScale;
    ray_o.x *= iResolution.x / iResolution.y;
    eyeRay_o = (inverseModelViewMatrix * ray_o).xyz;
  }

  // -0.5..0.5 is full box. AABB_CLIP lets us clip to a box shaped ROI to look at
  // I am applying it here at the earliest point so that the ray march does
  // not waste steps.  For general shaped ROI, this has to be handled more
  // generally (obviously)
  vec3 boxMin = AABB_CLIP_MIN;
  vec3 boxMax = AABB_CLIP_MAX;

  float tnear, tfar;
  bool hit = intersectBox(eyeRay_o, eyeRay_d, boxMin, boxMax, tnear, tfar);

  if (!hit) {
    // return background color if ray misses the cube
    // is this safe to do when there is other geometry / gObjects drawn?
    gl_FragColor = vec4(0.0); //C1;//vec4(0.0);
    return;
  }

  float clipNear = 0.0;//-(dot(eyeRay_o.xyz, eyeNorm) + dNear) / dot(eyeRay_d.xyz, eyeNorm);
  float clipFar = 10000.0;//-(dot(eyeRay_o.xyz,-eyeNorm) + dFar ) / dot(eyeRay_d.xyz,-eyeNorm);

  // Sample the depth/position texture
  // If this is a depth texture, the r component is a depth value. If this is a position texture,
  // the xyz components are a view space position and w is 1.0 iff there's a mesh at this fragment.
  vec4 meshPosSample = texture2D(textureDepth, vUv);
  // Note: we make a different check for whether a mesh is present with depth vs. position textures.
  // Here's the check for depth textures:
  bool hasDepthValue = usingPositionTexture == 0 && meshPosSample.r < 1.0;

  // If there's a depth-contributing mesh at this fragment, we may need to terminate the ray early
  if (hasDepthValue || (usingPositionTexture == 1 && meshPosSample.a > 0.0)) {
    if (hasDepthValue) {
      // We're working with a depth value, so we need to convert back to view space position
      // Get a projection space position from depth and uv, and unproject back to view space
      vec4 meshProj = vec4(vUv * 2.0 - 1.0, meshPosSample.r * 2.0 - 1.0, 1.0);
      vec4 meshView = inverseProjMatrix * meshProj;
      meshPosSample = vec4(meshView.xyz / meshView.w, 1.0);
    }
    // Transform the mesh position to object space
    vec4 meshObj = inverseModelViewMatrix * meshPosSample;

    // Derive a t value for the mesh intersection
    // NOTE: divides by 0 when `eyeRay_d.z` is 0. Could be mitigated by picking another component
    //   to derive with when z is 0, but I found this was rare enough in practice to be acceptable.
    float tMesh = (meshObj.z - eyeRay_o.z) / eyeRay_d.z;
    if (tMesh < tfar) {
      clipFar = tMesh - tnear;
    }
  }

  //tnear and tfar are intersections of box
  vec4 C = integrateVolume(vec4(eyeRay_o, 1.0), vec4(eyeRay_d, 0.0), tnear, tfar, clipNear, clipFar, textureAtlas);

  C = clamp(C, 0.0, 1.0);
  gl_FragColor = C;
  return;
}
