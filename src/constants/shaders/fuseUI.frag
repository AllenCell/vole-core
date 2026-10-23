precision highp float;
precision highp int;
precision highp usampler2D;
precision highp sampler3D;

// the lut texture is a 256x1 rgba texture for each channel
uniform sampler2D lutSampler;

uniform vec2 lutMinMax;
uniform float opacity;

// src texture is the raw volume intensity data
uniform usampler2D srcTexture;

void main() {
    ivec2 vUv = ivec2(int(gl_FragCoord.x), int(gl_FragCoord.y));
    uint intensity = texelFetch(srcTexture, vUv, 0).r;
    float ilookup = float(float(intensity) - lutMinMax.x) / float(lutMinMax.y - lutMinMax.x);
    // apply lut to intensity:
    vec4 pix = texture(lutSampler, vec2(ilookup, 0.5));
    pix.a = pix.a * opacity;
    gl_FragColor = vec4(pix.rgb * pix.a, pix.a);
}
