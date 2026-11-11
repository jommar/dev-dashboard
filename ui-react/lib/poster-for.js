// poster-for.js — which poster a session carries: the one the registry's ids hash it to
// (pickPoster), so the bot bar and anything that previews a pick agree. A hash that names an id the
// registry no longer has (a removed poster cannot be picked, but be safe) falls back to the first entry.
import { POSTERS } from '../components/posters/index.js';
import { pickPoster } from '../../ui/bot-bar.js';

const POSTER_IDS = POSTERS.map(({ id }) => id);

export const posterFor = (sessionKey) =>
  POSTERS.find(({ id }) => id === pickPoster(sessionKey, POSTER_IDS)) ?? POSTERS[0];
