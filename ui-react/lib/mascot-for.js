// mascot-for.js — which mascot a session is: the one the registry's ids hash it to (pickMascot), so
// the bot bar and anything that previews a pick agree. A hash that names an id the registry no longer
// has (a removed mascot cannot be picked, but be safe) falls back to the first entry.
import { MASCOTS } from '../components/mascots/index.js';
import { pickMascot } from '../../ui/bot-bar.js';

const MASCOT_IDS = MASCOTS.map(({ id }) => id);

export const mascotFor = (sessionKey) =>
  MASCOTS.find(({ id }) => id === pickMascot(sessionKey, MASCOT_IDS)) ?? MASCOTS[0];
