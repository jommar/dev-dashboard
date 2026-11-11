import { memo } from 'react';
import { botClass, botLabel } from './mascot-support.js';

// Styles: the "mascot: pinch" block of styles/mascots.css. Renders the bare SVG; the caller owns size and position.
export const PinchBot = memo(function PinchBot({ state, facing = 'right', label }) {
  const name = botLabel('Pinch', state, label);
  return (
    <svg
      className={botClass('pinch', state, facing)}
      viewBox="0 0 100 100"
      role="img"
      aria-label={name}
    >
      <g className="bot-pinch-all">
        <g className="bot-pinch-face">
          <ellipse className="bot-pinch-shadow" cx="52" cy="92" rx="36" ry="4" />
          <g className="bot-pinch-crab">
            <path
              className="bot-pinch-ln bot-pinch-still"
              d="M27 78q-5 8-10 11M34 80q-3 7-7 10M42 80q-1 7-4 11"
            />
            <g className="bot-pinch-go">
              <path className="bot-pinch-ln bot-pinch-lg1" d="M27 78q-5 8-10 11M42 80q-1 7-4 11" />
              <path className="bot-pinch-ln bot-pinch-lg2" d="M34 80q-3 7-7 10" />
            </g>
            <ellipse className="bot-pinch-fl" cx="40" cy="72" rx="17" ry="12" />
            <ellipse className="bot-pinch-fl" cx="25" cy="80" rx="5" ry="3.5" />
            <g className="bot-pinch-hclaw">
              <g className="bot-pinch-claw">
                <path className="bot-pinch-ln" d="M27 70L17 64" />
                <path className="bot-pinch-fl" d="M7 63q-8-3-6-12q4 4 9 6z" />
                <g className="bot-pinch-hpin">
                  <path className="bot-pinch-fl bot-pinch-pin" d="M10 58q-3-9 5-12q0 7 4 10z" />
                </g>
                <ellipse className="bot-pinch-fl" cx="13" cy="62" rx="8" ry="6" />
              </g>
            </g>
            <g className="bot-pinch-heyes">
              <g className="bot-pinch-eyes">
                <path className="bot-pinch-ln" d="M32 63L28 38M38 61L42 36" />
                <g className="bot-pinch-blink">
                  <circle className="bot-pinch-eye" cx="28" cy="34" r="6" />
                  <circle className="bot-pinch-eye" cx="42" cy="32" r="6" />
                  <circle className="bot-pinch-pupil" cx="27" cy="35" r="2.6" />
                  <circle className="bot-pinch-pupil" cx="41" cy="33" r="2.6" />
                </g>
              </g>
            </g>
          </g>
          <circle className="bot-pinch-shell bot-pinch-spire" cx="87" cy="36" r="9" />
          <path className="bot-pinch-acc" d="M84 37a3.5 3.5 0 1 1 4.5 3.5" />
          <circle className="bot-pinch-shell" cx="66" cy="60" r="26" />
          <path
            className="bot-pinch-brace"
            d="M62 48q-5 0-5 5v2q0 4-4 4q4 0 4 4v2q0 5 5 5M70 48q5 0 5 5v2q0 4 4 4q-4 0-4 4v2q0 5-5 5"
          />
        </g>
        <g className="bot-pinch-badge">
          <circle className="bot-pinch-bg" cx="86" cy="14" r="11" />
          <g className="bot-pinch-ic bot-pinch-i-work">
            <circle cx="81" cy="14" r="2" />
            <circle cx="86" cy="14" r="2" />
            <circle cx="91" cy="14" r="2" />
          </g>
          <path className="bot-pinch-ic bot-pinch-i-idle" d="M86 8v7.5M86 20.5v.1" />
          <path className="bot-pinch-ic bot-pinch-i-done" d="M80.5 14.5l4 4 7-8" />
          <path className="bot-pinch-ic bot-pinch-i-fail" d="M81.5 9.5l9 9M90.5 9.5l-9 9" />
        </g>
      </g>
    </svg>
  );
});
