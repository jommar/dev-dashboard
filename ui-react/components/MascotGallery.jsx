// MascotGallery.jsx — the Mascots screen's two views of the registry (MASCOTS): a card per mascot
// showing all four states at two sizes, and a fake bottom bar where a few of them roam. Static: no
// session data, no polling. Both read the registry, so a newly registered mascot appears with no
// edit here. Styles: ui-react/styles/mascots-page.css; the roaming reuses bot-bar.css.
import { MASCOTS } from './mascots/index.js';
import { BOT_STATE_WORDS, botPose, laneStyle, restingSpots, roamFor } from '../../ui/bot-bar.js';

export const STATES = ['working', 'waiting', 'done', 'failed'];
// The bar's own height, and a size to look closely.
export const SIZES = [
  { id: 'bar', px: 56, caption: 'Bar size, 56 px' },
  { id: 'large', px: 160, caption: 'Large, 160 px' },
];

function StateFigure({ mascot, size, state, facing, moving }) {
  const { Component, id, name } = mascot;
  const word = BOT_STATE_WORDS[state];
  return (
    <figure
      className="mascots-figure"
      data-state={state}
      data-testid={`mascot-figure-${id}-${size.id}-${state}`}
    >
      <div className="mascots-art" style={{ '--mascots-size': `${size.px}px` }}>
        <Component state={state} facing={facing} moving={moving} label={`${name}: ${word}`} />
      </div>
      <figcaption>{word}</figcaption>
    </figure>
  );
}

function MascotCard({ mascot, facing, moving, picked }) {
  return (
    <li
      className="mascots-card"
      data-testid={`mascot-card-${mascot.id}`}
      data-picked={picked ? 'true' : undefined}
    >
      <div className="mascots-card-head">
        <h3 className="mascots-card-name">{mascot.name}</h3>
        <code className="mascots-card-id">{mascot.id}</code>
        {picked && <span className="mascots-card-picked">Picked</span>}
      </div>
      {SIZES.map((size) => (
        <div key={size.id} className="mascots-size">
          <p className="mascots-size-caption">{size.caption}</p>
          <div className="mascots-states" data-size={size.id}>
            {STATES.map((state) => (
              <StateFigure
                key={state}
                mascot={mascot}
                size={size}
                state={state}
                facing={facing}
                moving={moving}
              />
            ))}
          </div>
        </div>
      ))}
    </li>
  );
}

// One card per registered mascot. `pickedId` marks the card a typed session key hashes to.
export function MascotGallery({ facing, moving, pickedId }) {
  return (
    <ul
      className="mascots-grid"
      role="list"
      aria-label="Registered mascots"
      data-testid="mascots-grid"
    >
      {MASCOTS.map((mascot) => (
        <MascotCard
          key={mascot.id}
          mascot={mascot}
          facing={facing}
          moving={moving}
          picked={mascot.id === pickedId}
        />
      ))}
    </ul>
  );
}

// Every mascot twice: working, and one of the other states in turn, so a roaming, an idle and a
// finished bot are all in view. The keys are invented (nothing here is a session).
const PREVIEW_BOTS = MASCOTS.flatMap((mascot, index) =>
  ['working', ['waiting', 'done', 'failed'][index % 3]].map((state) => ({
    key: `preview:${mascot.id}:${state}`,
    mascot,
    state,
  })),
);

// A fake bottom bar. It uses the real bar's lane classes and custom properties (bot-bar.css), set by
// the same helpers (roamFor, restingSpots, laneStyle, botPose), so it walks, pauses and stands as the
// real one does, and stands still under reduced motion.
export function RoamingPreview() {
  const spots = restingSpots(PREVIEW_BOTS);
  return (
    <div
      className="mascots-roam"
      role="group"
      aria-label="Roaming preview"
      data-testid="mascots-roam"
    >
      {PREVIEW_BOTS.map(({ key, mascot, state }) => {
        const roam = roamFor(key);
        const pose = botPose(state, roam);
        const { Component, name } = mascot;
        return (
          <div
            key={key}
            className="bot-bar-lane"
            data-state={state}
            data-testid={`mascots-roam-${mascot.id}-${state}`}
            style={laneStyle(roam, spots.get(key))}
          >
            <div className="bot-bar-face mascots-roam-bot">
              <Component
                state={state}
                facing={pose.facing}
                moving={pose.stepping}
                label={`${name}: ${BOT_STATE_WORDS[state]}`}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
