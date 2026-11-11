import { memo } from 'react';
import { botClass, botLabel } from './mascot-support.js';

// Styles: the "mascot: wick" block of styles/mascots.css. Renders the bare SVG; the caller owns size and position.
export const WickBot = memo(function WickBot({ state, facing = 'right', label, moving = false }) {
  const name = botLabel('Wick', state, label);
  return (
    <svg
      className={botClass('wick', state, facing, moving && 'walk')}
      viewBox="0 0 64 84"
      role="img"
      aria-label={name}
    >
      <g className="bot-wick-turn">
        <g className="bot-wick-step">
          <g className="bot-wick-all">
            <circle className="bot-wick-glow" cx="32" cy="40" r="27" />
            <g className="bot-wick-feet bot-wick-feet--stand">
              <ellipse cx="24" cy="81" rx="4.6" ry="2.6" />
              <ellipse cx="40" cy="81" rx="4.6" ry="2.6" />
            </g>
            <g className="bot-wick-feet bot-wick-feet--walk">
              <ellipse className="bot-wick-foot" cx="24" cy="81" rx="4.6" ry="2.6" />
              <ellipse className="bot-wick-foot" cx="40" cy="81" rx="4.6" ry="2.6" />
            </g>
            <path
              className="bot-wick-wax"
              d="M16 62a4 4 0 0 1 4-4h24a4 4 0 0 1 4 4v14a3 3 0 0 1-3 3H19a3 3 0 0 1-3-3z"
            />
            <path className="bot-wick-drip" d="M21 58.8h7v7a3.5 3.5 0 0 1-7 0z" />
            <g className="bot-wick-lean">
              <g className="bot-wick-perk">
                <g className="bot-wick-flame">
                  <path
                    className="bot-wick-fire"
                    d="M32 8C42 20 50 30 50 42a18 18 0 0 1-36 0C14 30 22 20 32 8z"
                  />
                  <path
                    className="bot-wick-core"
                    d="M32 24c6 8 10 13 10 20a10 10 0 0 1-20 0c0-7 4-12 10-20z"
                  />
                  <g className="bot-wick-gaze">
                    <g className="bot-wick-eyes">
                      <g className="bot-wick-blink">
                        <ellipse cx="27.5" cy="43" rx="2.3" ry="3.1" />
                        <ellipse cx="36.5" cy="43" rx="2.3" ry="3.1" />
                      </g>
                    </g>
                    <path className="bot-wick-m bot-wick-m--working" d="M29 49q3 2.2 6 0" />
                    <circle className="bot-wick-m bot-wick-m--idle" cx="32" cy="50" r="1.5" />
                    <path className="bot-wick-m bot-wick-m--done" d="M28 48.5q4 5 8 0z" />
                    <path className="bot-wick-m bot-wick-m--failed" d="M29 51.5q3-2.6 6 0" />
                  </g>
                </g>
              </g>
            </g>
          </g>
        </g>
      </g>
      <g className="bot-wick-b bot-wick-b--working">
        <circle className="bot-wick-ember" cx="27" cy="12" r="1.4" />
        <circle className="bot-wick-ember" cx="37" cy="10" r="1.1" />
        <circle className="bot-wick-ember" cx="32" cy="5" r="1.2" />
      </g>
      <g className="bot-wick-b bot-wick-b--idle">
        <path
          className="bot-wick-bubble"
          d="M49.5 2h7a5.5 5.5 0 0 1 0 11H50l-5 3.5 1.2-4.2A5.5 5.5 0 0 1 49.5 2z"
        />
        <circle className="bot-wick-dot" cx="48.8" cy="7.5" r="1.3" />
        <circle className="bot-wick-dot" cx="53" cy="7.5" r="1.3" />
        <circle className="bot-wick-dot" cx="57.2" cy="7.5" r="1.3" />
      </g>
      <g className="bot-wick-b bot-wick-b--done">
        <g className="bot-wick-x">
          <circle className="bot-wick-seal" cx="53" cy="10" r="7.5" />
          <path className="bot-wick-tick" d="M49.3 10.2l2.6 2.6 4.9-5.2" />
        </g>
      </g>
      <g className="bot-wick-b bot-wick-b--failed">
        <path className="bot-wick-smoke" d="M22 18c-3-3 3-5 0-8s3-5 0-8" />
        <g className="bot-wick-x">
          <circle className="bot-wick-seal" cx="53" cy="10" r="7.5" />
          <path className="bot-wick-tick" d="M50 7l6 6M56 7l-6 6" />
        </g>
      </g>
      <g className="bot-wick-sparks">
        <path className="bot-wick-spark" d="M9 27l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2L6 30l2.2-.8z" />
        <path
          className="bot-wick-spark"
          d="M55 33l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2L52 36l2.2-.8z"
        />
        <path className="bot-wick-spark" d="M14 6l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2L11 9l2.2-.8z" />
        <path
          className="bot-wick-spark"
          d="M50 53l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2L47 56l2.2-.8z"
        />
      </g>
      <g className="bot-wick-crackle">
        <circle cx="28.5" cy="5" r="1" />
        <circle cx="35.5" cy="4" r="0.9" />
        <circle cx="32" cy="1" r="1.1" />
      </g>
    </svg>
  );
});
