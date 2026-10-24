// The headsup mark at text size: an up-caret in the surrounding text color, plus a magenta dot that
// shows only when headsup acted (notes going in, or waiting for an OK). Same shape as Brand/Glyph in Figma.
export function glyph(dot: boolean): string {
  return `<svg class="glyph" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">`
    + `<path d="M4 18 12 10l8 8" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>`
    + (dot ? `<circle class="dot" cx="19.5" cy="4.5" r="3.5"/>` : '')
    + `</svg>`;
}

export const ACCENT = { light: '#e0186c', dark: '#ff3d8b' };
