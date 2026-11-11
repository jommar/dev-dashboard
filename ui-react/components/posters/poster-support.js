// What the five poster components share: the class list and the fit of the ticket key.
// Every poster is drawn in an 84 x 50 viewBox (a board about 72 x 30 on a pole), so the bar can lay
// out any of them the same way.
export const POSTER_WIDTH = 84;
export const POSTER_HEIGHT = 50;

/** `poster-<slug>` plus `poster-<slug>--moving` while the bot walks. */
export const posterClass = (slug, moving) =>
  moving ? `poster-${slug} poster-${slug}--moving` : `poster-${slug}`;

// A monospace glyph is about this share of its font size wide.
const GLYPH_EM = 0.6;

/**
 * The `textLength` of a ticket key on a board that has `room` user units for it, set in `size` px:
 * the key's own width, so a short one ("AB-1") is not stretched, and never more than `room`, so the
 * longest ("TRIPS-12345") is squeezed (spacing and glyphs) to fit instead of overflowing.
 */
export const keyLength = (text, room, size) =>
  Math.min(room, Math.round(String(text).length * size * GLYPH_EM * 10) / 10);
