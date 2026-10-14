// Small WebGL2 helpers: program compilation (with async parallel compile)
// and float render targets.
(() => {
  const FSRX = (globalThis.FSRX ??= {});

  // Interval between completion checks while the driver compiles in parallel.
  const COMPILE_POLL_MS = 16;

  /** Full-screen triangle; v_pos covers [0,1]² with row 0 at v_pos.y = 0. */
  const FULLSCREEN_VS = `#version 300 es
out vec2 v_pos;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_pos = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('Failed to allocate a shader object');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function describeFailure(gl, program, fragment, label) {
    const fsLog = gl.getShaderInfoLog(fragment);
    const linkLog = gl.getProgramInfoLog(program);
    return `Shader "${label}" failed: ${(fsLog || linkLog || 'unknown error').trim()}`;
  }

  /**
   * Compiles and links several fragment programs. With KHR_parallel_shader_compile
   * the wait does not block the page, which matters for the large FSRCNNX passes.
   * @param {WebGL2RenderingContext} gl
   * @param {Array<{label: string, fragment: string}>} sources
   * @returns {Promise<Array<WebGLProgram>>}
   */
  async function buildPrograms(gl, sources) {
    const parallel = gl.getExtension('KHR_parallel_shader_compile');
    const vertex = compileShader(gl, gl.VERTEX_SHADER, FULLSCREEN_VS);
    const entries = sources.map(({ label, fragment }) => {
      const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragment);
      const program = gl.createProgram();
      gl.attachShader(program, vertex);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      return { label, program, fs };
    });

    if (parallel) {
      const isDone = (e) => gl.getProgramParameter(e.program, parallel.COMPLETION_STATUS_KHR);
      while (!entries.every(isDone)) {
        if (gl.isContextLost()) throw new Error('GPU context lost while compiling shaders');
        await delay(COMPILE_POLL_MS);
      }
    }

    try {
      for (const e of entries) {
        if (!gl.getProgramParameter(e.program, gl.LINK_STATUS)) {
          throw new Error(describeFailure(gl, e.program, e.fs, e.label));
        }
      }
    } catch (err) {
      entries.forEach((e) => gl.deleteProgram(e.program));
      throw err;
    } finally {
      entries.forEach((e) => gl.deleteShader(e.fs));
      gl.deleteShader(vertex);
    }
    return entries.map((e) => e.program);
  }

  /** Caches uniform locations per program to avoid lookups every frame. */
  function uniformLocator(gl, program) {
    const cache = new Map();
    return (name) => {
      if (!cache.has(name)) cache.set(name, gl.getUniformLocation(program, name));
      return cache.get(name);
    };
  }

  /** RGBA16F texture + framebuffer, reallocated only when its size changes. */
  class RenderTarget {
    /** @param {WebGL2RenderingContext} gl */
    constructor(gl) {
      this.gl = gl;
      this.w = 0;
      this.h = 0;
      this.texture = createTexture(gl);
      this.framebuffer = gl.createFramebuffer();
    }

    resize(w, h) {
      if (w === this.w && h === this.h) return;
      const { gl } = this;
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(`Float framebuffer incomplete (0x${status.toString(16)})`);
      }
      this.w = w;
      this.h = h;
    }

    destroy() {
      this.gl.deleteTexture(this.texture);
      this.gl.deleteFramebuffer(this.framebuffer);
    }
  }

  /** Linear-filtered, edge-clamped 2D texture. */
  function createTexture(gl) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  FSRX.gl = { buildPrograms, uniformLocator, RenderTarget, createTexture };
})();
