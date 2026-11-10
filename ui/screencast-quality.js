// How closely a live view is watched, lowest first: a wall `tile` is a small, thin picture of a
// browser, `full` is the one being looked at in the viewer. Shared so the browser (which asks for
// a level) and the server (which streams it) cannot drift apart.
export const QUALITIES = ['tile', 'full'];

export const isQuality = (value) => QUALITIES.includes(value);

// The most demanding of several levels, or null when nobody is watching. A browser has one
// screencast whatever the number of watchers, so it runs at the highest level any of them asked for.
export function topQuality(levels) {
  let top = -1;
  for (const level of levels) top = Math.max(top, QUALITIES.indexOf(level));
  return top < 0 ? null : QUALITIES[top];
}
