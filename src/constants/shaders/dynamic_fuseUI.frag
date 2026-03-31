precision highp float;
precision highp int;
precision highp usampler2D;
precision highp usampler3D;

uniform sampler2D lutSampler;

// should be uvec2?
uniform vec2 lutMinMax;
uniform uint highlightedId;

// should be uvec3?
uniform ivec3 chunkOffset;
uniform ivec3 chunkSize;
uniform ivec2 atlasTileSize;
uniform ivec2 atlasDims;

uniform usampler3D srcTexture;

void main() {
    ivec2 uv = ivec2(int(gl_FragCoord.x), int(gl_FragCoord.y));
    ivec2 atlasCoord = uv / atlasTileSize;
    int z = atlasCoord.y * atlasDims.x + atlasCoord.x;
    ivec3 volumePos = ivec3(uv - atlasCoord * atlasTileSize, z);
    ivec3 chunkPos = volumePos - chunkOffset;

    if (any(0 > chunkPos) || any(chunkPos >= chunkSize)) {
        discard;
    }

    uint intensity = texelFetch(srcTexture, chunkPos / chunkSize, 0).r;
    float ilookup = float(float(intensity) - lutMinMax.x) / float(lutMinMax.y - lutMinMax.x);
    vec4 pix = texture(lutSampler, vec2(ilookup, 0.5));
    gl_FragColor = vec4(pix.xyz * pix.w, pix.w);
}
