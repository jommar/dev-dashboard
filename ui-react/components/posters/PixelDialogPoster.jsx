import { memo } from 'react';
import { POSTER_HEIGHT, POSTER_WIDTH, keyLength, posterClass } from './poster-support.js';

// "Pixel Dialog": an RPG text box (a notched white frame round a blue panel, a yellow "more" caret in
// the corner) clamped to a wooden pole. Decorative: hidden from assistive tech, no <title>, <desc> or
// title attribute.
export const PixelDialogPoster = memo(function PixelDialogPoster({ text, moving = false }) {
  return (
    <svg
      className={posterClass('pixel', moving)}
      viewBox={`0 0 ${POSTER_WIDTH} ${POSTER_HEIGHT}`}
      width={POSTER_WIDTH}
      height={POSTER_HEIGHT}
      aria-hidden="true"
      focusable="false"
    >
      <g className="poster-pixel-sway">
        <path className="poster-pixel-shadow" d="M10 4H78V6H80V32H78V34H10V32H8V6H10Z" />
        <rect className="poster-pixel-pole" x="40" y="32" width="4" height="18" />
        <rect className="poster-pixel-pole-lit" x="40" y="32" width="1" height="18" />
        <rect className="poster-pixel-clamp" x="37" y="32" width="10" height="3" />
        <path className="poster-pixel-frame" d="M8 2H76V4H78V30H76V32H8V30H6V4H8Z" />
        <path className="poster-pixel-board" d="M10 4H74V6H76V28H74V30H10V28H8V6H10Z" />
        <rect className="poster-pixel-lit" x="10" y="5" width="64" height="1" />
        <path className="poster-pixel-caret" d="M69 25H75V26H74V27H73V28H71V27H70V26H69Z" />
        <text
          className="poster-pixel-key"
          x="42"
          y="21"
          textAnchor="middle"
          textLength={keyLength(text, 58, 12)}
          lengthAdjust="spacingAndGlyphs"
        >
          {text}
        </text>
      </g>
    </svg>
  );
});
