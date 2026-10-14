// Built-in GLSL passes and the wrapper that turns an mpv hook body into a
// standalone WebGL2 fragment shader.
(() => {
  const FSRX = (globalThis.FSRX ??= {});

  const PRELUDE = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 v_pos;
out vec4 o_color;
`;

  // BT.709 full-range. The browser hands us gamma-encoded RGB, and FSRCNNX
  // was trained on gamma-encoded luma, so no linearisation is done.
  const YCBCR = `
const vec3 LUMA_COEF = vec3(0.2126, 0.7152, 0.0722);
vec3 rgbToYcbcr(vec3 c) {
  float y = dot(c, LUMA_COEF);
  return vec3(y, (c.b - y) / 1.8556, (c.r - y) / 1.5748);
}
vec3 ycbcrToRgb(vec3 v) {
  return vec3(v.x + 1.5748 * v.z, v.x - 0.1873 * v.y - 0.4681 * v.z, v.x + 1.8556 * v.y);
}
`;

  /** Video RGB -> YCbCr at source resolution; .x is what LUMA hooks read. */
  const CONVERT_FS = `${PRELUDE}${YCBCR}
uniform sampler2D u_src;
void main() {
  o_color = vec4(rgbToYcbcr(texture(u_src, v_pos).rgb), 1.0);
}`;

  /**
   * Single-channel AMD CAS on luma; keeps the other channels intact.
   * Constants follow the reference CAS: the 1e-4 floor avoids dividing by zero
   * on black, and the -1/8 .. -1/5 lobe range maps sharpness 0..1.
   */
  const SHARPEN_FS = `${PRELUDE}
uniform sampler2D u_luma;
uniform vec2 u_pt;
uniform float u_sharpness;
void main() {
  vec4 e = texture(u_luma, v_pos);
  float b = texture(u_luma, v_pos + vec2(0.0, -u_pt.y)).x;
  float d = texture(u_luma, v_pos + vec2(-u_pt.x, 0.0)).x;
  float f = texture(u_luma, v_pos + vec2(u_pt.x, 0.0)).x;
  float h = texture(u_luma, v_pos + vec2(0.0, u_pt.y)).x;
  float mn = clamp(min(min(min(b, d), min(f, h)), e.x), 0.0, 1.0);
  float mx = clamp(max(max(max(b, d), max(f, h)), e.x), 1e-4, 1.0);
  float amp = sqrt(clamp(min(mn, 1.0 - mx) / mx, 0.0, 1.0));
  float w = amp * (-1.0 / mix(8.0, 5.0, u_sharpness));
  o_color = vec4((e.x + (b + d + f + h) * w) / (1.0 + 4.0 * w), e.yzw);
}`;

  /**
   * Final composite to the canvas: luma scaling, chroma upsampling, YCbCr -> RGB.
   * In A/B mode the left side scales the unprocessed source luma with the same
   * scaler, so the comparison isolates what FSRCNNX adds.
   */
  const OUTPUT_FS = `${PRELUDE}${YCBCR}
uniform sampler2D u_luma;
uniform vec2 u_lumaSize;
uniform sampler2D u_yuv;
uniform vec2 u_srcSize;
uniform float u_antiring;
uniform vec4 u_crop;
uniform float u_split;
uniform int u_scaler;

// 9-tap Catmull-Rom using hardware bilinear filtering for the inner taps.
float catmullRom(sampler2D tex, vec2 size, vec2 uv) {
  vec2 samplePos = uv * size;
  vec2 texPos1 = floor(samplePos - 0.5) + 0.5;
  vec2 f = samplePos - texPos1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 offset12 = w2 / w12;
  vec2 pt = 1.0 / size;
  vec2 tc0 = (texPos1 - 1.0) * pt;
  vec2 tc3 = (texPos1 + 2.0) * pt;
  vec2 tc12 = (texPos1 + offset12) * pt;
  float r = 0.0;
  r += texture(tex, vec2(tc0.x, tc0.y)).x * w0.x * w0.y;
  r += texture(tex, vec2(tc12.x, tc0.y)).x * w12.x * w0.y;
  r += texture(tex, vec2(tc3.x, tc0.y)).x * w3.x * w0.y;
  r += texture(tex, vec2(tc0.x, tc12.y)).x * w0.x * w12.y;
  r += texture(tex, vec2(tc12.x, tc12.y)).x * w12.x * w12.y;
  r += texture(tex, vec2(tc3.x, tc12.y)).x * w3.x * w12.y;
  r += texture(tex, vec2(tc0.x, tc3.y)).x * w0.x * w3.y;
  r += texture(tex, vec2(tc12.x, tc3.y)).x * w12.x * w3.y;
  r += texture(tex, vec2(tc3.x, tc3.y)).x * w3.x * w3.y;
  return r;
}

float scaleLuma(sampler2D tex, vec2 size, vec2 uv) {
  return u_scaler == 1 ? catmullRom(tex, size, uv) : texture(tex, uv).x;
}

// Clamps luma to the 2x2 source neighbourhood, removing the dark/bright halos
// (overshoot) that both the CNN and Catmull-Rom produce around hard edges.
float antiring(float y, vec2 uv) {
  vec2 pt = 1.0 / u_srcSize;
  vec2 base = (floor(uv * u_srcSize - 0.5) + 0.5) * pt;
  float a = texture(u_yuv, base).x;
  float b = texture(u_yuv, base + vec2(pt.x, 0.0)).x;
  float c = texture(u_yuv, base + vec2(0.0, pt.y)).x;
  float d = texture(u_yuv, base + pt).x;
  float lo = min(min(a, b), min(c, d));
  float hi = max(max(a, b), max(c, d));
  return mix(y, clamp(y, lo, hi), u_antiring);
}

void main() {
  // The canvas framebuffer is bottom-up while all intermediates are top-down.
  vec2 p = vec2(v_pos.x, 1.0 - v_pos.y);
  vec2 uv = u_crop.xy + p * u_crop.zw;
  float y;
  if (u_split >= 0.0 && p.x < u_split) {
    y = scaleLuma(u_yuv, u_srcSize, uv);
  } else {
    y = scaleLuma(u_luma, u_lumaSize, uv);
    if (u_antiring > 0.0) y = antiring(y, uv);
  }
  vec3 rgb = ycbcrToRgb(vec3(y, texture(u_yuv, uv).yz));
  o_color = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`;

  /**
   * Wraps an mpv hook pass body, emulating the NAME_tex/NAME_texOff/... macros
   * that mpv generates for each bound texture.
   * @param {{hooks: string[], binds: string[], body: string}} pass
   * @returns {{fragment: string, textures: string[]}}
   */
  function wrapHookPass(pass) {
    const hooked = pass.hooks[0];
    const textures = [...new Set([hooked, ...pass.binds.filter((n) => n !== 'HOOKED')])];
    const declarations = textures.map((name) => `
uniform sampler2D ${name}_raw;
uniform vec2 ${name}_size;
uniform vec2 ${name}_pt;
#define ${name}_pos v_pos
#define ${name}_mul 1.0
#define ${name}_tex(pos) (${name}_mul * texture(${name}_raw, (pos)))
#define ${name}_texOff(off) ${name}_tex(${name}_pos + ${name}_pt * vec2(off))`).join('\n');
    const hookedAliases = ['raw', 'size', 'pt', 'pos', 'mul', 'tex', 'texOff']
      .map((suffix) => `#define HOOKED_${suffix} ${hooked}_${suffix}`).join('\n');

    const fragment = `${PRELUDE}
uniform vec2 input_size;
uniform vec2 target_size;
uniform int frame;
${declarations}
${hookedAliases}
${pass.body}
void main() { o_color = hook(); }`;
    return { fragment, textures };
  }

  FSRX.shaders = { CONVERT_FS, SHARPEN_FS, OUTPUT_FS, wrapHookPass };
})();
