// Translates an mpv hook pass body (GLSL) into a standalone WGSL fragment
// shader. The accepted grammar is deliberately narrow: exactly what the
// bundled FSRCNNX shaders use. Anything else throws "Unsupported construct"
// instead of being translated approximately.
(() => {
  const FSRX = (globalThis.FSRX ??= {});
  const { FULLSCREEN_VS } = FSRX.wgslPasses;

  /** GLSL declaration types -> WGSL. */
  const DECL_TYPES = { float: 'f32', int: 'i32', vec2: 'vec2f', vec3: 'vec3f', vec4: 'vec4f', ivec2: 'vec2i', mat4: 'mat4x4f' };
  /** GLSL constructors -> WGSL; component order of mat4 is column-major in both. */
  const CONSTRUCTORS = {
    vec2: 'vec2f', vec3: 'vec3f', vec4: 'vec4f', ivec2: 'vec2i', int: 'i32',
    mat4: 'mat4x4f', mat4x4: 'mat4x4f',
  };
  /** Built-ins whose GLSL and WGSL semantics match for the argument types used. */
  const FUNCTIONS = new Set(['max', 'min', 'fract', 'floor']);
  const UNIFORM_GLOBALS = new Set(['input_size', 'target_size', 'frame']);
  const MACRO_SUFFIXES = ['texOff', 'tex', 'pos', 'size', 'pt', 'mul', 'raw'];
  const SWIZZLE = /^[xyzw]{1,4}$|^[rgba]{1,4}$/;
  const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=']);

  const TOKEN = /\s*(?:(\d+\.\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|\d+(?:[eE][+-]?\d+)?)|([A-Za-z_]\w*)|([-+*/(),[\].]))/y;

  function unsupported(what, desc) {
    return new Error(`Неподдерживаемая конструкция ${what} в проходе «${desc}»`);
  }

  function tokenize(text, desc) {
    const tokens = [];
    TOKEN.lastIndex = 0;
    while (TOKEN.lastIndex < text.length) {
      if (/^\s*$/.test(text.slice(TOKEN.lastIndex))) break;
      const start = TOKEN.lastIndex;
      const m = TOKEN.exec(text);
      if (!m) throw unsupported(`"${text.slice(start, start + 12)}"`, desc);
      if (m[1] !== undefined) tokens.push({ type: 'num', text: m[1] });
      else if (m[2] !== undefined) tokens.push({ type: 'id', text: m[2] });
      else tokens.push({ type: 'op', text: m[3] });
    }
    return tokens;
  }

  /** Index of the ")" matching the "(" at `open`. */
  function matchParen(tokens, open, desc) {
    let depth = 0;
    for (let i = open; i < tokens.length; i++) {
      if (tokens[i].text === '(') depth++;
      else if (tokens[i].text === ')' && --depth === 0) return i;
    }
    throw unsupported('(непарные скобки)', desc);
  }

  /**
   * Translates GLSL expression tokens into WGSL text.
   * @param {object} ctx - {desc, locals: Set, macro: (id) => string | null}
   */
  function translateExpr(tokens, ctx) {
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      const next = tokens[i + 1];
      if (tok.type === 'num') {
        out.push(tok.text);
      } else if (tok.type === 'op') {
        if (tok.text === '.') {
          if (next?.type !== 'id' || !SWIZZLE.test(next.text)) throw unsupported('(обращение к полю)', ctx.desc);
          out.push(`.${next.text}`);
          i++;
        } else {
          // "- -x" must not collapse into WGSL's "--" decrement token.
          out.push(tok.text === '-' && out[out.length - 1]?.endsWith('-') ? ' -' : tok.text);
        }
      } else if (tok.text === 'float' && next?.text === '(') {
        // GLSL float(vec4) takes the first component; WGSL has no such conversion.
        const close = matchParen(tokens, i + 1, ctx.desc);
        out.push(`(${translateExpr(tokens.slice(i + 2, close), ctx)}).x`);
        i = close;
      } else if (Object.hasOwn(CONSTRUCTORS, tok.text) && next?.text === '(') {
        out.push(CONSTRUCTORS[tok.text]);
      } else if (FUNCTIONS.has(tok.text) && next?.text === '(') {
        out.push(tok.text);
      } else if (ctx.locals.has(tok.text)) {
        out.push(tok.text);
      } else if (UNIFORM_GLOBALS.has(tok.text)) {
        out.push(`u.${tok.text}`);
      } else {
        const mapped = ctx.macro(tok.text, next);
        if (mapped === null) throw unsupported(`"${tok.text}"`, ctx.desc);
        out.push(mapped);
        // texOff(<scalar>) means a uniform offset in GLSL (vec2(off) in the macro).
        if (mapped.endsWith('_texOff') && tokens[i + 2]?.type === 'num' && tokens[i + 3]?.text === ')') {
          out.push(`(vec2f(${tokens[i + 2].text}))`);
          i += 3;
        }
      }
    }
    return out.join('');
  }

  /** Resolves NAME_suffix texture macros (mpv generates them per bound texture). */
  function macroResolver(textures, hooked, desc) {
    return (id, next) => {
      for (const suffix of MACRO_SUFFIXES) {
        if (!id.endsWith(`_${suffix}`)) continue;
        const name = id.slice(0, -suffix.length - 1);
        const real = name === 'HOOKED' ? hooked : name;
        if (!textures.includes(real)) return null;
        switch (suffix) {
          case 'tex':
          case 'texOff':
            if (next?.text !== '(') return null;
            return `${real}_${suffix}`;
          case 'pos': return 'fragPos';
          case 'size':
          case 'pt': return `u.${real}_${suffix}`;
          case 'mul': return '1.0';
          default: throw unsupported(`(прямой доступ к сэмплеру "${id}")`, desc);
        }
      }
      return null;
    };
  }

  function stripComments(body) {
    return body.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
  }

  function translateBody(body, ctx) {
    const match = /^\s*vec4\s+hook\s*\(\s*\)\s*\{([\s\S]*)\}\s*$/.exec(stripComments(body));
    if (!match) throw unsupported('(тело прохода должно быть одной функцией "vec4 hook()")', ctx.desc);
    const inner = match[1];
    if (/[{}#]/.test(inner)) throw unsupported('(ветвления, циклы или препроцессор)', ctx.desc);
    const statements = inner.split(';').map((s) => s.trim()).filter(Boolean);
    const lines = statements.map((stmt) => translateStatement(stmt, ctx));
    return `fn hook() -> vec4f {\n${lines.map((l) => `  ${l}`).join('\n')}\n}`;
  }

  function translateStatement(stmt, ctx) {
    const decl = /^(\w+)\s+([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/.exec(stmt);
    if (decl && Object.hasOwn(DECL_TYPES, decl[1])) {
      const [, type, name, expr] = decl;
      if (ctx.locals.has(name)) throw unsupported(`(повторное объявление "${name}")`, ctx.desc);
      const wgsl = translateExpr(tokenize(expr, ctx.desc), ctx);
      ctx.locals.add(name);
      return `var ${name}: ${DECL_TYPES[type]} = ${wgsl};`;
    }
    const ret = /^return\s+([\s\S]+)$/.exec(stmt);
    if (ret) return `return ${translateExpr(tokenize(ret[1], ctx.desc), ctx)};`;
    const assign = /^([A-Za-z_]\w*)\s*([-+*]?=)\s*([\s\S]+)$/.exec(stmt);
    if (assign && ASSIGN_OPS.has(assign[2]) && ctx.locals.has(assign[1])) {
      return `${assign[1]} ${assign[2]} ${translateExpr(tokenize(assign[3], ctx.desc), ctx)};`;
    }
    throw unsupported(`"${stmt.slice(0, 40)}"`, ctx.desc);
  }

  /**
   * Byte layout of the per-pass uniform block: for each bound texture a
   * (size, pt) pair in one 16-byte slot, then input_size, target_size, frame.
   */
  function uniformLayout(textureCount) {
    const base = textureCount * 4;
    return {
      floats: base + 8,
      textureOffset: (i) => i * 4,
      inputSize: base,
      targetSize: base + 2,
      frame: base + 4,
    };
  }

  /**
   * @param {{hooks: string[], binds: string[], body: string, desc: string}} pass
   * @returns {{code: string, textures: string[]}} WGSL and the bound texture
   *   names in binding order (binding 2 + index)
   */
  function translateHookPass(pass) {
    const hooked = pass.hooks[0];
    const textures = [...new Set([hooked, ...pass.binds.filter((n) => n !== 'HOOKED')])];
    const desc = pass.desc || hooked;
    const ctx = { desc, locals: new Set(), macro: macroResolver(textures, hooked, desc) };
    const hookFn = translateBody(pass.body, ctx);

    const fields = textures.map((name) => `  ${name}_size: vec2f,\n  ${name}_pt: vec2f,`).join('\n');
    const bindings = textures.map((name, i) =>
      `@group(0) @binding(${i + 2}) var ${name}_raw: texture_2d<f32>;`).join('\n');
    const helpers = textures.map((name) => `
fn ${name}_tex(p: vec2f) -> vec4f { return textureSampleLevel(${name}_raw, samp, p, 0.0); }
fn ${name}_texOff(o: vec2f) -> vec4f { return ${name}_tex(fragPos + u.${name}_pt * o); }`).join('');

    const code = `${FULLSCREEN_VS}
struct Params {
${fields}
  input_size: vec2f,
  target_size: vec2f,
  frame: i32,
};
@group(0) @binding(0) var<uniform> u: Params;
@group(0) @binding(1) var samp: sampler;
${bindings}
var<private> fragPos: vec2f;
${helpers}

${hookFn}

@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  fragPos = in.pos;
  return hook();
}`;
    return { code, textures };
  }

  FSRX.wgslHook = { translateHookPass, uniformLayout };
})();
