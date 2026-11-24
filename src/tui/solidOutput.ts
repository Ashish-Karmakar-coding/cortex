import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { SOLID_BG_ANSI, SOLID_FG_ANSI, SOLID_SURFACE_ANSI } from './palette.js';

const SGR_REGEX = /\x1b\[([0-9;]*)m/g;
const ERASE_LINE_OR_SCREEN_REGEX = /(\x1b\[(?:0|1|2)?[KJ])/g;

function rewriteSgrCodes(input: string): string {
  return input.replace(SGR_REGEX, (_match, rawParams: string) => {
    if (!rawParams) {
      return `\x1b[0m${SOLID_SURFACE_ANSI}`;
    }

    const params = rawParams.split(';');
    let hasFullReset = false;
    const mapped: string[] = [];

    for (let i = 0; i < params.length; i++) {
      const p = params[i]!;
      if (p === '0' || p === '') {
        hasFullReset = true;
        mapped.push('0');
      } else if (p === '49') {
        mapped.push('48', '2', '44', '57', '48');
      } else if (p === '39') {
        mapped.push('38', '2', '220', '215', '201');
      } else {
        mapped.push(p);
      }
    }

    const seq = `\x1b[${mapped.join(';')}m`;
    return hasFullReset ? `${seq}${SOLID_SURFACE_ANSI}` : seq;
  });
}

/**
 * Transform an Ink frame or ANSI output string so every cell, border, margin,
 * and trailing space paints solidly with #2C3930 background and #DCD7C9
 * foreground—eliminating transparent gaps even in terminals that ignore OSC 11.
 */
export function transformSolidAnsi(chunk: string, columns = 80): string {
  if (!chunk) return chunk;

  // Preserve pure control sequences (cursor hide/show, OSC sequences) without
  // breaking them, while ensuring SGR resets and erasures keep solid #2C3930.
  let rewritten = rewriteSgrCodes(chunk).replace(
    ERASE_LINE_OR_SCREEN_REGEX,
    `${SOLID_BG_ANSI}$1`
  );

  const lines = rewritten.split('\n');
  if (lines.length === 1) {
    return `${SOLID_BG_ANSI}${rewritten}`;
  }

  const safeCols = Math.max(10, columns);
  const paintedLines = lines.map((line, idx) => {
    const isTrailingEmpty = idx === lines.length - 1 && line === '';
    if (isTrailingEmpty) return '';
    const visibleWidth = stringWidth(stripAnsi(line));
    // Only emit EL (\x1b[K) when cursor hasn't reached the rightmost column so
    // full-width lines don't erase their final column character.
    const fillTail = visibleWidth < safeCols ? `${SOLID_BG_ANSI}\x1b[K` : '';
    return `${SOLID_BG_ANSI}${line}${fillTail}`;
  });

  return paintedLines.join('\n');
}

/**
 * Wrap a NodeJS.WriteStream (process.stdout) for Ink so every rendered frame
 * paints a solid, non-transparent #2C3930 surface across the entire viewport.
 */
export function createSolidStdout(target: NodeJS.WriteStream): NodeJS.WriteStream {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop === 'write') {
        return (
          chunk: string | Uint8Array,
          encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
          cb?: (err?: Error | null) => void
        ) => {
          const cols = obj.columns || 80;
          const payload =
            typeof chunk === 'string'
              ? transformSolidAnsi(chunk, cols)
              : transformSolidAnsi(Buffer.from(chunk).toString('utf-8'), cols);

          if (typeof encodingOrCb === 'function') {
            return obj.write(payload, encodingOrCb);
          }
          if (encodingOrCb !== undefined) {
            return obj.write(payload, encodingOrCb, cb);
          }
          return obj.write(payload);
        };
      }
      const value = Reflect.get(obj, prop, receiver);
      return typeof value === 'function' ? value.bind(obj) : value;
    },
  });
}
