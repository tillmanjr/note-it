// Formatting choices shared by the main toolbar and the selection format bar.
export const FONTS = ['', 'Arial', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'Trebuchet MS']
export const SIZES = ['', '10px', '12px', '14px', '16px', '18px', '20px', '24px', '30px', '36px']
/**
 * Theme-aware text colors: maximum / minimum contrast against the page. The host app sets
 * --note-max / --note-min per theme (black/white in light mode, white/black in dark mode);
 * the fallbacks apply wherever the note is rendered without them (exports, other apps).
 */
export const CONTRAST_MAX = 'var(--note-max, #000000)'
export const CONTRAST_MIN = 'var(--note-min, #ffffff)'
export const COLORS = [CONTRAST_MAX, CONTRAST_MIN, '#c0392b', '#d35400', '#27ae60', '#2980b9', '#8e44ad', '#7f8c8d']

/** Tooltip for a text color swatch. */
export function colorLabel(color: string): string {
  if (color === CONTRAST_MAX) return 'Maximum contrast (black in light mode, white in dark mode)'
  if (color === CONTRAST_MIN) return 'Minimum contrast (white in light mode, black in dark mode)'
  return `Text ${color}`
}
export const HIGHLIGHTS = ['#fff3a3', '#c8f7c5', '#cfe8ff', '#ffd6e7']
export const MONOSPACE_FONT = "ui-monospace, 'Cascadia Mono', Consolas, Menlo, 'Courier New', monospace"
