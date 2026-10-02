precision highp float;
precision highp int;
precision highp usampler2D;
precision highp sampler3D;

/**
 * LUT mapping from the segmentation ID (raw pixel value) to the
 * global ID (index in data buffers like 'featureData' and 'outlierData').
 * 
 * For a given local pixel ID 'localId', the global ID is given by:
 * 'localIdToGlobalId[localId - localIdOffset] - 1'.
*/
uniform usampler2D localIdToGlobalId;
uniform uint localIdOffset;
uniform bool useGlobalIdLookup;
/* Pick buffer. Used to determine IDs. */
uniform sampler2D pickBuffer;

/** 
 * A mapping of IDs that are selected in the current track(s). For some object
 * with ID given by 'i', 'selectedIds[i] >= 1' if the object is selected.
 *
 * For selected objects, 'selectedIds[i] - 1' is the index into the
 * 'outlinePalette' for the outline color that should be used when
 * 'useOutlinePalette' is true.
 */
uniform usampler2D selectedIds;
/** 
 * Legacy method of highlighting a single ID. Uses the 'outlineColor' for the outline 
 * or 'outlinePalette[0]' when 'useOutlinePalette' is true.
*/
uniform int selectedId;
/**
 * If true, uses the 'outlinePalette' to outline selected tracks based on the
 * selected ID, and shows an additional inner outline. When false, uses
 * 'outlineColor' for outlines.
 */
uniform bool useOutlinePalette;
uniform int outlineThickness;
uniform float outlineAlpha;
uniform vec3 outlineColor;
uniform sampler2D outlinePalette;
uniform vec3 innerOutlineColor;
uniform int innerOutlineThickness;
uniform float devicePixelRatio;

const uint BACKGROUND_ID = 0u;
const int MISSING_DATA_ID = -1;
const int ID_OFFSET = 1;

uvec4 getUintFromTex(usampler2D tex, int index) {
  int width = textureSize(tex, 0).x;
  ivec2 featurePos = ivec2(index % width, index / width);
  return uvec4(texelFetch(tex, featurePos, 0));
}

vec4 getOutlineColor(int colorIdx) {
  if (!useOutlinePalette) {
    return vec4(outlineColor, 1);
  }
  float width = float(textureSize(outlinePalette, 0).x);
  float adjustedIdx = (0.5 + float(colorIdx)) / width;
  return texture(outlinePalette, vec2(adjustedIdx, 0.5));
}

/**
 * Gets the label ID (aka raw pixel value) of the pixel at the given scaled UV
 * coordinates.
 */
uint getLabelId(ivec2 uv) {
  return uint(texelFetch(pickBuffer, uv, 0).g);
}

/**
 * Looks up the global ID value from its label ID. The global ID can be used to
 * get data about this object from data buffers like 'featureData' and
 * 'outlierData'.
 * @returns One of the following:
 * - '-1' (=MISSING_DATA_ID) if the pixel is missing data or is part of the
     background.
 * - The global ID at the given coordinates.
 */
int getGlobalId(uint labelId) {
  if (labelId == BACKGROUND_ID) {
    return MISSING_DATA_ID;
  }
  int localId = int(labelId) - int(localIdOffset);
  if (!useGlobalIdLookup) {
    return localId - ID_OFFSET;
  }
  uvec4 c = getUintFromTex(localIdToGlobalId, localId);
  // Note: IDs are offset by 'ID_OFFSET' ('=1') to reserve '0' for local IDs
  // that don't have associated data in the global lookup. 'ID_OFFSET' MUST be
  // subtracted from the ID when accessing data buffers.
  uint globalId = c.r;
  if (globalId == 0u) {
    return MISSING_DATA_ID;
  }
  return int(globalId) - ID_OFFSET;
}

bool isEdge(ivec2 uv, uint labelId, int thickness) {
  // TODO: This has some visual artifacts at really high/low zoom levels,
  // possibly due to coords being cast to an 'ivec2' for texture sampling.

  // Keep thickness constant in screen space
  float wStep = 1.0 / devicePixelRatio;
  float hStep = 1.0 / devicePixelRatio;
  float thicknessFloat = float(thickness);
  // sample around the pixel to see if we are on an edge
  uint R = (getLabelId(uv + ivec2(thicknessFloat * wStep, 0)));
  uint L = (getLabelId(uv + ivec2(-thicknessFloat * wStep, 0)));
  uint T = (getLabelId(uv + ivec2(0, thicknessFloat * hStep)));
  uint B = (getLabelId(uv + ivec2(0, -thicknessFloat * hStep)));
  // if any neighbors are not id then this is an edge
  return labelId != BACKGROUND_ID && (R != labelId || L != labelId || T != labelId || B != labelId);
}

void main(void) {
  ivec2 vUv = ivec2(int(gl_FragCoord.x / devicePixelRatio), int(gl_FragCoord.y / devicePixelRatio));

  uint labelId = getLabelId(vUv);
  int globalId = getGlobalId(labelId);

  if (globalId == MISSING_DATA_ID || labelId == BACKGROUND_ID) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }

  uint selectionIdx = getUintFromTex(selectedIds, globalId).r;
  if (selectionIdx > 0u || globalId == selectedId) {
    if (isEdge(vUv, labelId, outlineThickness)) {
      // If matched on 'selectedId' only, selectionIdx will be 0. Use color index 0.
      int colorIdx = max(0, int(selectionIdx) - 1);
      vec4 color = getOutlineColor(colorIdx);
      gl_FragColor = vec4(color.rgb, outlineAlpha);
    } else if (innerOutlineThickness > 0 && isEdge(vUv, labelId, outlineThickness + innerOutlineThickness)) {
      // Optionally apply an additional inner outline for increased contrast.
      gl_FragColor = vec4(innerOutlineColor.rgb, outlineAlpha);
    }
  } else {
    gl_FragColor = vec4(0, 0, 0, 0.0);
  }
}