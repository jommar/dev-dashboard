import { memo } from 'react';
import { POSTER_HEIGHT, POSTER_WIDTH, keyLength, posterClass } from './poster-support.js';

// "Next Stop": a transit sign (a rounded blue board with a white rim, a yellow route dot with an
// arrow) on a grey pole. Decorative: hidden from assistive tech, no <title>, <desc> or title attribute.
export const NextStopPoster = memo(function NextStopPoster({ text, moving = false }) {
  return (
    <svg
      className={posterClass('wild', moving)}
      viewBox={`0 0 ${POSTER_WIDTH} ${POSTER_HEIGHT}`}
      width={POSTER_WIDTH}
      height={POSTER_HEIGHT}
      aria-hidden="true"
      focusable="false"
    >
      <g className="poster-wild-sway">
        <rect className="poster-wild-pole" x="40.5" y="30" width="3" height="20" rx="1" />
        <rect className="poster-wild-board" x="6" y="1" width="72" height="30" rx="4" />
        <rect className="poster-wild-rim" x="8.2" y="3.2" width="67.6" height="25.6" rx="2.4" />
        <circle className="poster-wild-dot" cx="15.6" cy="16" r="4.6" />
        <path className="poster-wild-arrow" d="M14.4 13.4 17 16l-2.6 2.6" />
        <rect className="poster-wild-clamp" x="38" y="31" width="8" height="3" rx="1" />
        <text
          className="poster-wild-key"
          x="47.5"
          y="20.3"
          textAnchor="middle"
          textLength={keyLength(text, 50, 12)}
          lengthAdjust="spacingAndGlyphs"
        >
          {text}
        </text>
      </g>
    </svg>
  );
});
