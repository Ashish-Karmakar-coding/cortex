// Cortex UI palette. Kept dependency-free so it can be imported by both the
// Ink TUI and the plain readline fallback without pulling React into pipe mode.
export const palette = {
  /** Solid terminal / app background */
  bg: '#2C3930',
  /** Primary foreground used for text, borders, and interactive elements */
  fg: '#DCD7C9',
  /** Secondary text (comments, hints, metadata) */
  muted: '#A9A498',
  /** Subtle borders and separators inside panels */
  border: '#5F6F63',
  /** Semantic colors — used for diffs, statuses, and errors only */
  success: '#A8C6A9',
  warning: '#D9C08A',
  danger: '#D99A8F',
  /** Elevated surface / selection background (solid dark green) */
  surface: '#344339',
  selection: '#3A4A3F',
} as const;

export const SOLID_BG_ANSI = '\x1b[48;2;44;57;48m';
export const SOLID_FG_ANSI = '\x1b[38;2;220;215;201m';
export const SOLID_SURFACE_ANSI = `${SOLID_BG_ANSI}${SOLID_FG_ANSI}`;

/** ANSI truecolor escapes for the plain (non-Ink) terminal mode. */
export const ansi = {
  bg: SOLID_BG_ANSI,
  fg: '\x1b[38;2;220;215;201m',
  muted: '\x1b[38;2;169;164;152m',
  success: '\x1b[38;2;168;198;169m',
  warning: '\x1b[38;2;217;192;138m',
  danger: '\x1b[38;2;217;154;143m',
  bold: '\x1b[1m',
  reset: `\x1b[0m${SOLID_SURFACE_ANSI}`,
} as const;

let restoreTheme: (() => void) | null = null;

/** OSC color values use XParseColor syntax, e.g. rgb:2c/39/30. */
function toOscRgb(hex: string): string {
  return `rgb:${hex.slice(1, 3)}/${hex.slice(3, 5)}/${hex.slice(5, 7)}`;
}

/**
 * Paint the terminal solid with Cortex's #2C3930 background and #DCD7C9
 * foreground via both OSC 10/11/12 and truecolor SGR Back-Color-Erase screen
 * fill, restoring the user's original terminal theme on exit.
 */
export function applyTerminalTheme(paintScreen = true): void {
  if (restoreTheme || !process.stdout.isTTY) {
    return;
  }

  const out = process.stdout;
  out.write(
    `\x1b]10;${toOscRgb(palette.fg)}\x07` +
      `\x1b]11;${toOscRgb(palette.bg)}\x07` +
      `\x1b]12;${toOscRgb(palette.fg)}\x07` +
      SOLID_SURFACE_ANSI +
      (paintScreen ? '\x1b[2J\x1b[H' : '')
  );

  const restore = () => {
    if (!restoreTheme) return;
    restoreTheme = null;
    try {
      out.write('\x1b[0m\x1b]110\x07\x1b]111\x07\x1b]112\x07');
    } catch {
      // Stdout may already be closed during shutdown.
    }
  };

  restoreTheme = restore;
  process.once('exit', restore);
}
