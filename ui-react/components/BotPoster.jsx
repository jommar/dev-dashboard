// BotPoster.jsx — the sign a bot carries above its head, showing its ticket key. Which poster is the
// session's own (posterFor: rendezvous hashing over the registry in posters/index.js). It is decorative
// (aria-hidden, no title), takes no pointer and is drawn beside the bot's mirrored face, never inside
// it, so the key is never reversed. Positioned by bot-bar.css (`.bot-bar-poster`), in the real bar and
// in the Mascots page's roaming preview alike. `moving` is true while the bot walks, which is what sways it.
import { memo } from 'react';
import { posterFor } from '../lib/poster-for.js';

export const BotPoster = memo(function BotPoster({ botKey, text, moving, testId }) {
  const { id, Component } = posterFor(botKey);
  return (
    <div className="bot-bar-poster" aria-hidden="true" data-testid={testId} data-poster={id}>
      <Component text={text} moving={moving} />
    </div>
  );
});
