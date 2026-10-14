// Parser for the mpv user-shader ("//!HOOK") format used by FSRCNNX.
// Only the subset needed by luma prescalers is supported: HOOK, BIND, SAVE,
// DESC, COMPONENTS, WIDTH, HEIGHT, WHEN.
(() => {
  const FSRX = (globalThis.FSRX ??= {});

  const BINARY_OPS = {
    '+': (a, b) => a + b,
    '-': (a, b) => a - b,
    '*': (a, b) => a * b,
    '/': (a, b) => a / b,
    '>': (a, b) => Number(a > b),
    '<': (a, b) => Number(a < b),
    '=': (a, b) => Number(a === b),
  };
  const SIZE_FIELDS = { w: 'w', width: 'w', h: 'h', height: 'h' };

  /**
   * Compiles an mpv RPN size expression ("LUMA.w 2 *") into tokens.
   * @param {string} expr
   */
  function compileRpn(expr) {
    return expr.trim().split(/\s+/).map((raw) => {
      if (Object.hasOwn(BINARY_OPS, raw)) return { op: raw };
      if (raw === '!') return { op: '!' };
      const num = Number(raw);
      if (Number.isFinite(num)) return { num };
      const [name, field] = raw.split('.');
      if (!name || !Object.hasOwn(SIZE_FIELDS, field)) {
        throw new Error(`Неподдерживаемый элемент выражения "${raw}"`);
      }
      return { name, field: SIZE_FIELDS[field] };
    });
  }

  /**
   * Evaluates compiled RPN tokens.
   * @param {Array<object>} tokens
   * @param {(name: string) => ({w: number, h: number} | undefined)} sizeOf
   */
  function evalRpn(tokens, sizeOf) {
    const stack = [];
    for (const token of tokens) {
      if (token.num !== undefined) {
        stack.push(token.num);
      } else if (token.name) {
        const size = sizeOf(token.name);
        if (!size) throw new Error(`Неизвестная текстура "${token.name}" в выражении`);
        stack.push(size[token.field]);
      } else if (token.op === '!') {
        stack.push(Number(!stack.pop()));
      } else {
        const b = stack.pop();
        const a = stack.pop();
        if (a === undefined || b === undefined) throw new Error('Некорректное выражение размера');
        stack.push(BINARY_OPS[token.op](a, b));
      }
    }
    if (stack.length !== 1) throw new Error('Некорректное выражение размера');
    return stack[0];
  }

  const SUPPORTED_DIRECTIVES = new Set(['HOOK', 'BIND', 'SAVE', 'DESC', 'COMPONENTS', 'WIDTH', 'HEIGHT', 'WHEN']);

  function newPass() {
    return { hooks: [], binds: [], save: null, desc: '', width: null, height: null, when: null, body: [] };
  }

  function applyDirective(pass, line) {
    const match = /^\/\/!(\w+)\s*(.*)$/.exec(line);
    if (!match) throw new Error(`Некорректная директива: ${line}`);
    const [, directive, arg] = match;
    if (!SUPPORTED_DIRECTIVES.has(directive)) {
      throw new Error(`Неподдерживаемая директива шейдера //!${directive}`);
    }
    switch (directive) {
      case 'HOOK': pass.hooks.push(arg.trim()); break;
      case 'BIND': pass.binds.push(arg.trim()); break;
      case 'SAVE': pass.save = arg.trim(); break;
      case 'DESC': pass.desc = arg.trim(); break;
      case 'WIDTH': pass.width = compileRpn(arg); break;
      case 'HEIGHT': pass.height = compileRpn(arg); break;
      case 'WHEN': pass.when = compileRpn(arg); break;
      // Target formats are picked per texture name (LUMA single-channel, feature
      // maps four), so the declared component count is not needed.
      case 'COMPONENTS': break;
    }
  }

  /**
   * Splits an mpv hook shader into passes. Each pass starts with a block of
   * "//!" directives followed by its GLSL body.
   * @param {string} source
   */
  function parseHookShader(source) {
    const passes = [];
    let pass = null;
    for (const line of source.split(/\r?\n/)) {
      if (line.startsWith('//!')) {
        if (!pass || pass.body.length > 0) {
          if (pass) passes.push(pass);
          pass = newPass();
        }
        applyDirective(pass, line);
      } else if (pass) {
        pass.body.push(line);
      }
    }
    if (pass) passes.push(pass);

    return passes.map((p) => {
      if (!p.hooks.includes('LUMA')) {
        throw new Error(`Поддерживаются только проходы для LUMA (проход «${p.desc}»)`);
      }
      return { ...p, body: p.body.join('\n') };
    });
  }

  FSRX.mpvHook = { compileRpn, evalRpn, parseHookShader };
})();
