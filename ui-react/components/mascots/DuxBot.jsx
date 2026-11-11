import { memo } from 'react';
import { botClass, botLabel } from './mascot-support.js';

// Styles: the "mascot: dux" block of styles/mascots.css. Renders the bare SVG; the caller owns size and position.
export const DuxBot = memo(function DuxBot({ state, facing = 'right', label, moving = false }) {
  const name = botLabel('Dux', state, label);
  return (
    <svg
      className={botClass('dux', state, facing, moving && 'moving')}
      viewBox="0 0 64 66"
      role="img"
      aria-label={name}
    >
      <g className="bot-dux-ripple bot-dux-st bot-dux-st-i">
        <ellipse cx="31" cy="62" rx="26" ry="3.2" />
      </g>
      <g className="bot-dux-char">
        <g className="bot-dux-react">
          <g className="bot-dux-gait">
            <g className="bot-dux-duck">
              <g className="bot-dux-feet-stand">
                <ellipse className="bot-dux-foot-s" cx="24" cy="61" rx="5" ry="2.4" />
                <ellipse className="bot-dux-foot-s" cx="38" cy="61" rx="5" ry="2.4" />
              </g>
              <g className="bot-dux-feet-walk">
                <ellipse className="bot-dux-foot" cx="24" cy="61" rx="5" ry="2.4" />
                <ellipse className="bot-dux-foot" cx="38" cy="61" rx="5" ry="2.4" />
              </g>
              <path
                className="bot-dux-skin"
                d="M9 30C12 33 15 35 18 35C22 33 28 32 34 33L50 34C55 37 54 50 46 54C38 58 20 58 14 52C8 47 7 38 9 30Z"
              />
              <g className="bot-dux-head">
                <circle className="bot-dux-skin" cx="38" cy="22" r="12" />
                <ellipse
                  className="bot-dux-blush bot-dux-st bot-dux-st-d"
                  cx="40"
                  cy="27"
                  rx="3"
                  ry="1.8"
                />
                <path
                  className="bot-dux-beak bot-dux-jaw"
                  d="M47.5 25L59.5 23.5C59 27 53 29 48 28Z"
                />
                <path className="bot-dux-beak" d="M47 21C53 18.5 59 20.5 59.5 23.5L47.5 25Z" />
                <g className="bot-dux-squeak">
                  <path d="M61.5 20.5q2 3 0 6" />
                  <path d="M64 18.5q3 5 0 10" />
                </g>
                <g className="bot-dux-eyes">
                  <g className="bot-dux-eye">
                    <ellipse className="bot-dux-pupil" cx="41" cy="19" rx="2.3" ry="3.1" />
                    <circle className="bot-dux-shine" cx="41.9" cy="17.7" r=".8" />
                  </g>
                </g>
                <path className="bot-dux-brow bot-dux-st bot-dux-st-w" d="M37.5 13.6L44 14.6" />
                <path
                  className="bot-dux-brow bot-dux-st bot-dux-st-i"
                  d="M37.5 13Q41 10 44.5 12.4"
                />
                <path
                  className="bot-dux-brow bot-dux-st bot-dux-st-d"
                  d="M38 13.4Q41 11.6 44 12.8"
                />
                <path
                  className="bot-dux-brow bot-dux-st bot-dux-st-f"
                  d="M37.5 12.6Q41 15.2 44.5 14"
                />
                <path
                  className="bot-dux-drop bot-dux-st bot-dux-st-f"
                  d="M27 6c-1.6 2.4-2.4 3.6-2.4 4.8a2.4 2.4 0 0 0 4.8 0c0-1.2-.8-2.4-2.4-4.8z"
                />
              </g>
              <path className="bot-dux-wing" d="M20 41C27 36 38 38 40 44C36 50 26 50 20 46Z" />
            </g>
          </g>
        </g>
      </g>
      <g className="bot-dux-stars bot-dux-st bot-dux-st-d">
        <g transform="translate(8 20)">
          <path className="bot-dux-star" d="M0-4L1-1 4 0 1 1 0 4-1 1-4 0-1-1Z" />
        </g>
        <g transform="translate(58 38)">
          <path className="bot-dux-star" d="M0-4L1-1 4 0 1 1 0 4-1 1-4 0-1-1Z" />
        </g>
        <g transform="translate(22 6)">
          <path className="bot-dux-star" d="M0-4L1-1 4 0 1 1 0 4-1 1-4 0-1-1Z" />
        </g>
      </g>
      <g className="bot-dux-badge">
        <circle cx="55" cy="9" r="7" />
        <path className="bot-dux-spin bot-dux-st bot-dux-st-w" d="M55 5.4A3.6 3.6 0 1 1 51.4 9" />
        <g className="bot-dux-st bot-dux-st-i">
          <path d="M52.8 7a2.3 2.3 0 1 1 3.2 2.1c-.8.4-1 .9-1 1.7" />
          <circle className="bot-dux-dot" cx="55" cy="13.3" r=".95" />
        </g>
        <path className="bot-dux-st bot-dux-st-d" d="M51.8 9.2l2.2 2.2 4.2-4.4" />
        <path className="bot-dux-st bot-dux-st-f" d="M52.5 6.5l5 5M57.5 6.5l-5 5" />
      </g>
    </svg>
  );
});
