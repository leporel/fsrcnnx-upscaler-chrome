// Built-in WGSL passes: RGB -> YCbCr conversion, CAS sharpening and the final
// composite. All textures are top-down (row 0 = top), and so is the WebGPU
// framebuffer, so no pass needs a vertical flip.
(() => {
  const FSRX = (globalThis.FSRX ??= {});

  /** Full-screen triangle; `pos` covers [0,1]² with row 0 at pos.y = 0 (top). */
  const FULLSCREEN_VS = `
struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) pos: vec2f,
};
@vertex fn vs(@builtin(vertex_index) i: u32) -> VsOut {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var out: VsOut;
  out.position = vec4f(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
  out.pos = p;
  return out;
}`;

  // BT.709 full-range. The browser hands us gamma-encoded RGB, and FSRCNNX
  // was trained on gamma-encoded luma, so no linearisation is done.
  const YCBCR = `
const LUMA_COEF = vec3f(0.2126, 0.7152, 0.0722);
fn rgbToYcbcr(c: vec3f) -> vec3f {
  let y = dot(c, LUMA_COEF);
  return vec3f(y, (c.b - y) / 1.8556, (c.r - y) / 1.5748);
}
fn ycbcrToRgb(v: vec3f) -> vec3f {
  return vec3f(v.x + 1.5748 * v.z, v.x - 0.1873 * v.y - 0.4681 * v.z, v.x + 1.8556 * v.y);
}`;

  /**
   * Source RGB -> YCbCr at source resolution; .x is what LUMA hooks read.
   * The linear sampler also resamples inputs whose size differs from the
   * target (it renders at the source size whatever texture it is given).
   */
  const CONVERT = `${FULLSCREEN_VS}
${YCBCR}
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;
@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  return vec4f(rgbToYcbcr(textureSampleLevel(src, samp, in.pos, 0.0).rgb), 1.0);
}`;

  /**
   * Single-channel AMD CAS on luma; keeps the other channels intact.
   * Constants follow the reference CAS: the 1e-4 floor avoids dividing by zero
   * on black, and the -1/8 .. -1/5 lobe range maps sharpness 0..1.
   */
  const SHARPEN = `${FULLSCREEN_VS}
struct Params { pt: vec2f, sharpness: f32 };
@group(0) @binding(0) var<uniform> u: Params;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var luma: texture_2d<f32>;
fn tap(p: vec2f) -> f32 { return textureSampleLevel(luma, samp, p, 0.0).x; }
@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  let e = textureSampleLevel(luma, samp, in.pos, 0.0);
  let b = tap(in.pos + vec2f(0.0, -u.pt.y));
  let d = tap(in.pos + vec2f(-u.pt.x, 0.0));
  let f = tap(in.pos + vec2f(u.pt.x, 0.0));
  let h = tap(in.pos + vec2f(0.0, u.pt.y));
  let mn = clamp(min(min(min(b, d), min(f, h)), e.x), 0.0, 1.0);
  let mx = clamp(max(max(max(b, d), max(f, h)), e.x), 1e-4, 1.0);
  let amp = sqrt(clamp(min(mn, 1.0 - mx) / mx, 0.0, 1.0));
  let w = amp * (-1.0 / mix(8.0, 5.0, u.sharpness));
  return vec4f((e.x + (b + d + f + h) * w) / (1.0 + 4.0 * w), e.yzw);
}`;

  /**
   * Final composite to the canvas: luma scaling, chroma upsampling, YCbCr -> RGB.
   * In A/B mode the left side shows the original picture: the unprocessed
   * luma and chroma of the last real source frame, scaled with the same
   * scaler, so the comparison isolates what the whole pipeline adds.
   */
  const COMPOSITE = `${FULLSCREEN_VS}
${YCBCR}
struct Params {
  lumaSize: vec2f,
  srcSize: vec2f,
  crop: vec4f,
  antiring: f32,
  split: f32,
  scaler: f32,
};
@group(0) @binding(0) var<uniform> u: Params;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var luma: texture_2d<f32>;
@group(0) @binding(3) var yuv: texture_2d<f32>;
@group(0) @binding(4) var original: texture_2d<f32>;

// 9-tap Catmull-Rom using hardware bilinear filtering for the inner taps.
fn catmullRom(tex: texture_2d<f32>, size: vec2f, uv: vec2f) -> f32 {
  let samplePos = uv * size;
  let texPos1 = floor(samplePos - 0.5) + 0.5;
  let f = samplePos - texPos1;
  let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  let w3 = f * f * (-0.5 + 0.5 * f);
  let w12 = w1 + w2;
  let offset12 = w2 / w12;
  let pt = 1.0 / size;
  let tc0 = (texPos1 - 1.0) * pt;
  let tc3 = (texPos1 + 2.0) * pt;
  let tc12 = (texPos1 + offset12) * pt;
  var r = 0.0;
  r += textureSampleLevel(tex, samp, vec2f(tc0.x, tc0.y), 0.0).x * w0.x * w0.y;
  r += textureSampleLevel(tex, samp, vec2f(tc12.x, tc0.y), 0.0).x * w12.x * w0.y;
  r += textureSampleLevel(tex, samp, vec2f(tc3.x, tc0.y), 0.0).x * w3.x * w0.y;
  r += textureSampleLevel(tex, samp, vec2f(tc0.x, tc12.y), 0.0).x * w0.x * w12.y;
  r += textureSampleLevel(tex, samp, vec2f(tc12.x, tc12.y), 0.0).x * w12.x * w12.y;
  r += textureSampleLevel(tex, samp, vec2f(tc3.x, tc12.y), 0.0).x * w3.x * w12.y;
  r += textureSampleLevel(tex, samp, vec2f(tc0.x, tc3.y), 0.0).x * w0.x * w3.y;
  r += textureSampleLevel(tex, samp, vec2f(tc12.x, tc3.y), 0.0).x * w12.x * w3.y;
  r += textureSampleLevel(tex, samp, vec2f(tc3.x, tc3.y), 0.0).x * w3.x * w3.y;
  return r;
}

fn scaleLuma(tex: texture_2d<f32>, size: vec2f, uv: vec2f) -> f32 {
  if (u.scaler > 0.5) { return catmullRom(tex, size, uv); }
  return textureSampleLevel(tex, samp, uv, 0.0).x;
}

// Clamps luma to the 2x2 source neighbourhood, removing the dark/bright halos
// (overshoot) that both the CNN and Catmull-Rom produce around hard edges.
fn antiring(y: f32, uv: vec2f) -> f32 {
  let pt = 1.0 / u.srcSize;
  let base = (floor(uv * u.srcSize - 0.5) + 0.5) * pt;
  let a = textureSampleLevel(yuv, samp, base, 0.0).x;
  let b = textureSampleLevel(yuv, samp, base + vec2f(pt.x, 0.0), 0.0).x;
  let c = textureSampleLevel(yuv, samp, base + vec2f(0.0, pt.y), 0.0).x;
  let d = textureSampleLevel(yuv, samp, base + pt, 0.0).x;
  let lo = min(min(a, b), min(c, d));
  let hi = max(max(a, b), max(c, d));
  return mix(y, clamp(y, lo, hi), u.antiring);
}

@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  let uv = u.crop.xy + in.pos * u.crop.zw;
  var ycc: vec3f;
  if (u.split >= 0.0 && in.pos.x < u.split) {
    ycc = vec3f(scaleLuma(original, u.srcSize, uv), textureSampleLevel(original, samp, uv, 0.0).yz);
  } else {
    var y = scaleLuma(luma, u.lumaSize, uv);
    if (u.antiring > 0.0) { y = antiring(y, uv); }
    ycc = vec3f(y, textureSampleLevel(yuv, samp, uv, 0.0).yz);
  }
  return vec4f(clamp(ycbcrToRgb(ycc), vec3f(0.0), vec3f(1.0)), 1.0);
}`;

  FSRX.wgslPasses = { FULLSCREEN_VS, CONVERT, SHARPEN, COMPOSITE };
})();
