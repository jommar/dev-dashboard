import { memo } from 'react';
import { POSTER_HEIGHT, POSTER_WIDTH, keyLength, posterClass } from './poster-support.js';

// "Open Late": a neon sign (a glowing pink tube round a dark board, the key lit in cyan-white) on a
// metal pole. Decorative: hidden from assistive tech, no <title>, <desc> or title attribute.
export const OpenLatePoster = memo(function OpenLatePoster({ text, moving = false }) {
  return (
    <svg
      className={posterClass('glow', moving)}
      viewBox={`0 0 ${POSTER_WIDTH} ${POSTER_HEIGHT}`}
      width={POSTER_WIDTH}
      height={POSTER_HEIGHT}
      aria-hidden="true"
      focusable="false"
    >
      <g className="poster-glow-sway">
        <rect className="poster-glow-metal" x="40.5" y="32" width="3" height="18" rx="1" />
        <rect className="poster-glow-board" x="6" y="2" width="72" height="30" rx="4" />
        <path
          className="poster-glow-tube"
          d="M20 28.5h-7.5a3 3 0 0 1-3-3v-17a3 3 0 0 1 3-3h59a3 3 0 0 1 3 3v17a3 3 0 0 1-3 3H26"
        />
        <rect className="poster-glow-cap" x="19" y="27.5" width="2" height="2" rx=".5" />
        <rect className="poster-glow-cap" x="25" y="27.5" width="2" height="2" rx=".5" />
        <rect className="poster-glow-metal" x="37" y="31" width="10" height="3" rx="1" />
        <text
          className="poster-glow-key"
          x="42"
          y="21"
          textAnchor="middle"
          textLength={keyLength(text, 56, 11)}
          lengthAdjust="spacingAndGlyphs"
        >
          {text}
        </text>
      </g>
    </svg>
  );
});
