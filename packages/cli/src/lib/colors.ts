/**
 * Minimal semantic palette — a few lines of ANSI instead of a dependency
 * (CLI polish brief §8). Two accents and red; anything more competes with
 * itself. Disabled when not a TTY, when NO_COLOR is set, or on --no-color.
 */
export interface Palette {
  accent(text: string): string;
  dim(text: string): string;
  red(text: string): string;
}

const wrap = (open: string, close: string) => (text: string) => `[${open}m${text}[${close}m`;

const COLORED: Palette = {
  accent: wrap('36', '39'), // cyan
  dim: wrap('2', '22'),
  red: wrap('31', '39'),
};

const PLAIN: Palette = {
  accent: (text) => text,
  dim: (text) => text,
  red: (text) => text,
};

export function makePalette(enabled: boolean): Palette {
  return enabled ? COLORED : PLAIN;
}
