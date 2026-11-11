import { memo } from 'react';
import { botClass, botLabel } from './mascot-support.js';

// Styles: the "mascot: crab" block of styles/mascots.css. Renders the bare SVG; the caller owns size and position.
export const PinchCrabBot = memo(function PinchCrabBot({ state, facing = 'right', label }) {
  const name = botLabel('Pinch', state, label);
  return (
    <svg
      className={botClass('crab', state, facing)}
      viewBox="0 0 64 64"
      role="img"
      aria-label={name}
    >
      <ellipse className="bot-crab-shadow" cx="30" cy="60.6" rx="25" ry="2.4" />
      <g className="bot-crab-all">
        <g className="bot-crab-head">
          <g className="bot-crab-claw bot-crab-claw--b">
            <path className="bot-crab-limb" d="M50 51l6 3" />
            <path className="bot-crab-skin" d="M58 50.5a3.5 3.5 0 1 0 3.5 3.5H58z" />
          </g>
          <g className="bot-crab-claw bot-crab-claw--a">
            <path className="bot-crab-limb" d="M50 48l6-3" />
            <path className="bot-crab-skin" d="M57 38.5a5.5 5.5 0 1 0 5.5 5.5H57z" />
          </g>
          <path className="bot-crab-limb bot-crab-leg bot-crab-leg--1" d="M37 52l-2 7.5" />
          <path className="bot-crab-limb bot-crab-leg bot-crab-leg--2" d="M43 53v7" />
          <path className="bot-crab-limb bot-crab-leg bot-crab-leg--3" d="M49 52l2 7.5" />
          <ellipse className="bot-crab-skin" cx="44" cy="46" rx="11" ry="8" />
          <path className="bot-crab-mouth bot-crab-mouth--up" d="M47.5 48.5q2.5 2.2 5 0" />
          <path className="bot-crab-mouth bot-crab-mouth--down" d="M47.5 50q2.5-2.2 5 0" />
          <g className="bot-crab-eyes">
            <path className="bot-crab-limb" d="M43 40V26M50 40l2-12" />
            <g className="bot-crab-blink">
              <circle className="bot-crab-eye" cx="43" cy="22" r="4.2" />
              <circle className="bot-crab-eye" cx="52" cy="24" r="4.2" />
              <path className="bot-crab-pupil" d="M44.2 22.3h.01M53.2 24.3h.01" />
              <path
                className="bot-crab-x"
                d="M41.4 20.4l3.2 3.2m0-3.2l-3.2 3.2M50.4 22.4l3.2 3.2m0-3.2l-3.2 3.2"
              />
            </g>
          </g>
        </g>
        <g transform="translate(0 7)">
          <g className="bot-crab-pack">
            <circle className="bot-crab-shell" cx="11" cy="18" r="3.5" />
            <path className="bot-crab-shell" d="M3 47C3 25 12 12 24 12c10 0 16 8 16 22v13z" />
            <rect className="bot-crab-screen" x="10" y="22" width="22" height="18" rx="4" />
            <g className="bot-crab-unflip">
              <g className="bot-crab-glyph bot-crab-glyph--working">
                <path className="bot-crab-code" d="M13.5 27h14" />
                <path className="bot-crab-code" d="M13.5 31h9" />
                <path className="bot-crab-code" d="M13.5 35h12" />
              </g>
              <path
                className="bot-crab-glyph bot-crab-glyph--idle"
                d="M17.6 28.6a3.4 3.4 0 1 1 5 3c-1 .6-1.6 1.2-1.6 2.4M21 37.4h.01"
              />
              <path className="bot-crab-glyph bot-crab-glyph--done" d="M15.5 31.5l4 4 7.5-8.5" />
              <path className="bot-crab-glyph bot-crab-glyph--failed" d="M16.5 26.5l9 9m0-9l-9 9" />
            </g>
            <path className="bot-crab-glyph bot-crab-rays" d="M22 8V3M12 10L9 6M32 10l3-4" />
          </g>
        </g>
      </g>
    </svg>
  );
});
