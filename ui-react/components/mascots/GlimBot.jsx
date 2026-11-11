import { memo } from 'react';
import { botClass, botLabel } from './mascot-support.js';

// Styles: the "mascot: glim" block of styles/mascots.css. Renders the bare SVG; the caller owns size and position.
export const GlimBot = memo(function GlimBot({ state, facing = 'right', label }) {
  const name = botLabel('Glim', state, label);
  return (
    <svg
      className={botClass('glim', state, facing)}
      viewBox="0 0 64 64"
      role="img"
      aria-label={name}
    >
      <g className="bot-glim-g-face">
        <g className="bot-glim-g-float">
          <g className="bot-glim-g-lean">
            <g className="bot-glim-g-tilt">
              <circle className="bot-glim-halo" cx="32" cy="45" r="17" />
              <circle className="bot-glim-ping bot-glim-x bot-glim-s-idle" cx="32" cy="45" r="14" />
              <g className="bot-glim-trail">
                <circle className="bot-glim-mote" cx="12" cy="45" r="1.8" />
                <circle className="bot-glim-mote bot-glim-m2" cx="7" cy="40" r="1.3" />
                <circle className="bot-glim-mote bot-glim-m3" cx="6" cy="50" r="1.1" />
              </g>
              <g className="bot-glim-w">
                <ellipse
                  className="bot-glim-wing"
                  cx="18"
                  cy="28"
                  rx="7"
                  ry="12"
                  transform="rotate(-40 18 28)"
                />
              </g>
              <g transform="matrix(-1 0 0 1 64 0)">
                <g className="bot-glim-w">
                  <ellipse
                    className="bot-glim-wing"
                    cx="18"
                    cy="28"
                    rx="7"
                    ry="12"
                    transform="rotate(-40 18 28)"
                  />
                </g>
              </g>
              <ellipse className="bot-glim-glow" cx="32" cy="45" rx="10.5" ry="12" />
              <ellipse className="bot-glim-shine" cx="27.5" cy="40" rx="2.2" ry="3.4" />
              <g className="bot-glim-ln bot-glim-ic">
                <path
                  className="bot-glim-x bot-glim-s-work"
                  d="M27 44l-3 3 3 3M37 44l3 3-3 3M33.5 43l-3 8"
                />
                <path className="bot-glim-x bot-glim-s-idle" d="M32 41v5.5M32 51v.1" />
                <path className="bot-glim-x bot-glim-s-done" d="M27 47l3.5 3.5 6.5-7" />
                <path className="bot-glim-x bot-glim-s-fail" d="M28.5 43.5l7 7m0-7l-7 7" />
              </g>
              <g className="bot-glim-a">
                <path className="bot-glim-ln bot-glim-ant" d="M28 12Q26 5 20 4" />
                <circle className="bot-glim-tip" cx="20" cy="4" r="2.3" />
              </g>
              <g transform="matrix(-1 0 0 1 64 0)">
                <g className="bot-glim-a">
                  <path className="bot-glim-ln bot-glim-ant" d="M28 12Q26 5 20 4" />
                  <circle className="bot-glim-tip" cx="20" cy="4" r="2.3" />
                </g>
              </g>
              <circle className="bot-glim-body" cx="32" cy="22" r="13" />
              <circle className="bot-glim-cheek" cx="23.5" cy="27.5" r="2" />
              <circle className="bot-glim-cheek" cx="40.5" cy="27.5" r="2" />
              <g className="bot-glim-eyes">
                <g className="bot-glim-blink">
                  <g className="bot-glim-open">
                    <ellipse className="bot-glim-eye" cx="27" cy="22" rx="2.6" ry="3.4" />
                    <ellipse className="bot-glim-eye" cx="37" cy="22" rx="2.6" ry="3.4" />
                  </g>
                  <path
                    className="bot-glim-ln bot-glim-face bot-glim-x bot-glim-s-done"
                    d="M24 23q3-4 6 0m4 0q3-4 6 0"
                  />
                </g>
              </g>
              <g className="bot-glim-ln bot-glim-face">
                <path className="bot-glim-x bot-glim-s-fail" d="M24 17.5l5-2M40 17.5l-5-2" />
                <path className="bot-glim-x bot-glim-s-work" d="M30 29.5h4" />
                <circle className="bot-glim-x bot-glim-s-idle" cx="32" cy="29.5" r="1.3" />
                <path className="bot-glim-x bot-glim-s-done" d="M28.5 28.5q3.5 3.5 7 0" />
                <path className="bot-glim-x bot-glim-s-fail" d="M29 31q3-3 6 0" />
              </g>
            </g>
          </g>
        </g>
        <g className="bot-glim-x bot-glim-s-done">
          <g transform="translate(9 14)">
            <path className="bot-glim-spark" d="M0-4L1-1 4 0 1 1 0 4-1 1-4 0-1-1z" />
          </g>
          <g transform="translate(55 11)">
            <path className="bot-glim-spark bot-glim-sp2" d="M0-4L1-1 4 0 1 1 0 4-1 1-4 0-1-1z" />
          </g>
          <g transform="translate(56 38)">
            <path className="bot-glim-spark bot-glim-sp3" d="M0-4L1-1 4 0 1 1 0 4-1 1-4 0-1-1z" />
          </g>
        </g>
      </g>
    </svg>
  );
});
