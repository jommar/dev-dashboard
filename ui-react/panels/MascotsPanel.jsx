import { useState } from 'react';
import { BoardPanel, BoardSection } from '../components/BoardShell.jsx';
import { MascotGallery, PosterGallery, RoamingPreview } from '../components/MascotGallery.jsx';
import { Button } from '../components/Primitives.jsx';
import { MASCOTS } from '../components/mascots/index.js';
import { POSTERS } from '../components/posters/index.js';
import { mascotFor } from '../lib/mascot-for.js';

const FACINGS = ['left', 'right'];

// The Mascots tab: every registered mascot in all four states, for looking and picking, then every
// registered poster (the sign a bot carries with its ticket key), still and swaying. It is a
// static page: no session data, no fetch, no polling. Replay remounts the pictures, so the one-time
// done hop and failed shake can be watched again.
export function MascotsPanel({ active }) {
  const [facing, setFacing] = useState('right');
  const [moving, setMoving] = useState(false);
  const [replays, setReplays] = useState(0);
  const [sessionKey, setSessionKey] = useState('');
  const picked = sessionKey.trim() ? mascotFor(sessionKey.trim()) : null;

  const controls = (
    <>
      <div className="mascots-controls-group" role="group" aria-label="Facing">
        <span className="mascots-controls-label" aria-hidden="true">
          Facing
        </span>
        {FACINGS.map((side) => (
          <Button
            key={side}
            className="mascots-toggle"
            data-testid={`mascots-facing-${side}`}
            aria-pressed={facing === side}
            onClick={() => setFacing(side)}
          >
            {side === 'left' ? 'Left' : 'Right'}
          </Button>
        ))}
      </div>
      <Button
        className="mascots-toggle"
        data-testid="mascots-moving"
        aria-pressed={moving}
        onClick={() => setMoving((value) => !value)}
      >
        Moving
      </Button>
      <Button data-testid="mascots-replay" onClick={() => setReplays((count) => count + 1)}>
        Replay
      </Button>
    </>
  );

  const filters = (
    <form className="mascots-pick" onSubmit={(event) => event.preventDefault()}>
      <label>
        Which mascot would a session get?
        <input
          data-testid="mascots-pick-input"
          value={sessionKey}
          maxLength={80}
          placeholder="TAP-1234:implement"
          onChange={(event) => setSessionKey(event.target.value)}
        />
      </label>
      <output className="mascots-pick-result" data-testid="mascots-pick-result">
        {picked ? `${picked.name} (${picked.id})` : ''}
      </output>
    </form>
  );

  return (
    <BoardPanel id="mascots" active={active}>
      <BoardSection
        name="mascots"
        title="Mascots"
        sub={`${MASCOTS.length} ${MASCOTS.length === 1 ? 'mascot' : 'mascots'} registered`}
        controls={controls}
        filters={filters}
      >
        <div className="board-pane mascots-pane" data-testid="mascots-pane">
          <div key={replays} className="mascots-content">
            <section className="mascots-section" aria-labelledby="mascots-roam-title">
              <h3 id="mascots-roam-title" className="mascots-heading">
                Roaming preview
              </h3>
              <p className="mascots-note">
                A fake bottom bar: the real bar&apos;s walking, pausing and standing, with a working
                bot and one of another state per mascot, each carrying its poster.
              </p>
              <RoamingPreview />
            </section>
            <MascotGallery facing={facing} moving={moving} pickedId={picked?.id} />
            <section className="mascots-section" aria-labelledby="mascots-posters-title">
              <h3 id="mascots-posters-title" className="mascots-heading">
                Posters
              </h3>
              <p className="mascots-note">
                <span data-testid="posters-sub">{`${POSTERS.length} ${POSTERS.length === 1 ? 'poster' : 'posters'} registered`}</span>
                . Every bot carries one with its ticket key, picked by its session; it sways while
                the bot walks.
              </p>
              <PosterGallery />
            </section>
          </div>
        </div>
      </BoardSection>
    </BoardPanel>
  );
}
