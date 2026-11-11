import { memo } from 'react';
import { POSTER_HEIGHT, POSTER_WIDTH, keyLength, posterClass } from './poster-support.js';

// "First Class": an airmail stamp (perforated edge, red and blue chevron border) on a wooden pole.
// Decorative, so hidden from assistive tech and with no <title>, <desc> or title attribute (the
// browser would show it as a native tooltip). The ticket key is one <text>, fitted to the stamp.
export const FirstClassPoster = memo(function FirstClassPoster({ text, moving = false }) {
  return (
    <svg
      className={posterClass('paper', moving)}
      viewBox={`0 0 ${POSTER_WIDTH} ${POSTER_HEIGHT}`}
      width={POSTER_WIDTH}
      height={POSTER_HEIGHT}
      aria-hidden="true"
      focusable="false"
    >
      <g className="poster-paper-sway">
        <rect className="poster-paper-pole" x="40.5" y="30" width="3" height="20" rx="1.5" />
        <rect className="poster-paper-stamp" x="6" y="2" width="72" height="30" />
        <rect className="poster-paper-air poster-paper-red" x="10" y="6" width="64" height="22" />
        <rect className="poster-paper-air poster-paper-blue" x="10" y="6" width="64" height="22" />
        <circle className="poster-paper-mark" cx="71" cy="8" r="5" />
        <path className="poster-paper-mark" d="M54 6q3-2 6 0t6 0M54 9.5q3-2 6 0t6 0" />
        <circle className="poster-paper-tack" cx="42" cy="29" r="1.3" />
        <text
          className="poster-paper-key"
          x="42"
          y="21.5"
          textAnchor="middle"
          textLength={keyLength(text, 56, 12)}
          lengthAdjust="spacingAndGlyphs"
        >
          {text}
        </text>
      </g>
    </svg>
  );
});
