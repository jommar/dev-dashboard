import { memo } from 'react';
import { POSTER_HEIGHT, POSTER_WIDTH, keyLength, posterClass } from './poster-support.js';

// "Picket Sign": a cardboard placard (uneven corners, corrugated line, two strips of tape) stapled to
// a wooden stick. Decorative: hidden from assistive tech, no <title>, <desc> or title attribute.
export const PicketSignPoster = memo(function PicketSignPoster({ text, moving = false }) {
  return (
    <svg
      className={posterClass('craft', moving)}
      viewBox={`0 0 ${POSTER_WIDTH} ${POSTER_HEIGHT}`}
      width={POSTER_WIDTH}
      height={POSTER_HEIGHT}
      aria-hidden="true"
      focusable="false"
    >
      <g className="poster-craft-sway">
        <rect className="poster-craft-stick" x="39.5" y="14" width="5" height="36" rx="1.2" />
        <path className="poster-craft-grain" d="M41.3 34v14M42.9 37v9" />
        <path className="poster-craft-board" d="M6 4.5 77.5 2.5 78.5 31 5 32.5Z" />
        <path className="poster-craft-flute" d="M7.5 29.8 76.8 28.4" />
        <rect
          className="poster-craft-tape"
          x="2.5"
          y="1"
          width="13"
          height="5"
          transform="rotate(-24 9 3.5)"
        />
        <rect
          className="poster-craft-tape"
          x="35.5"
          y="29"
          width="13"
          height="6"
          transform="rotate(4 42 32)"
        />
        <text
          className="poster-craft-key"
          x="42"
          y="21.5"
          textAnchor="middle"
          textLength={keyLength(text, 60, 12)}
          lengthAdjust="spacingAndGlyphs"
          transform="rotate(-1.5 42 17)"
        >
          {text}
        </text>
      </g>
    </svg>
  );
});
