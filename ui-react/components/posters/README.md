# Posters

Small animated SVG signs, one per bot: the sign a bot on the bottom bar carries on a pole above its
head, showing the ticket key of its session (`TAP-1451`). `index.js` exports `POSTERS`, the only list of
them: the bar (through `BotPoster.jsx`), the dashboard's **Mascots** tab (every entry still and swaying,
and on the roaming preview's bots) and the picker read it, and none of them hard-code an id or a count.

A poster is decorative (`aria-hidden`, no name, no tooltip) and carries no state: the mascot shows that.
It sways gently while its bot walks and is still otherwise, and it is never mirrored when the bot turns
(the bar draws it beside the mirrored face, never inside it).

## Adding a poster

1. **Design it.** Run the prompt in `PROMPT.md` (this folder). Each designer writes `poster.svg.html`
   (one `<style>`, one `<svg>`) and a `preview.html` to a gitignored `.orchestrator/posters/<slug>/`
   folder; that scratch is never committed.
2. **Port the SVG** to `<Name>Poster.jsx` in this folder. Copy an existing one. The contract:
   - a named export, wrapped in `memo` so the bar's re-renders never restart the sway;
   - props `{ text, moving = false }`: `text` is the ticket key, `moving` is true while the bot walks;
   - renders only the `<svg>`: `viewBox="0 0 84 50"` (`POSTER_WIDTH` and `POSTER_HEIGHT` in
     `poster-support.js`; the pole's foot is at the bottom centre, 42 / 50, which is where the bar
     anchors it and where the sway turns), `aria-hidden="true"` and `focusable="false"`; never a
     `<title>`, `<desc>` or `title` attribute, which the browser would show as a native tooltip, and
     no `role` or `aria-label`;
   - the class list comes from `posterClass(slug, moving)` in `poster-support.js`
     (`poster-<slug>` plus `poster-<slug>--moving`);
   - the ticket key is **one** `<text>`, `textAnchor="middle"`, with `textLength={keyLength(text, room,
size)}` and `lengthAdjust="spacingAndGlyphs"`: `room` is the width of the board's text area and
     `size` the font size in px. A short key keeps its natural width and a long one
     (`TRIPS-12345`) is squeezed to `room`, so any key from `AB-1` to `TRIPS-12345` fits.
3. **Namespace everything.** Pick a one-word lowercase slug (usually the id; no hyphens, so no
   namespace is ever a prefix of another). Every class is `poster-<slug>` or `poster-<slug>-*`, the
   moving modifier is `poster-<slug>--moving`, every `@keyframes` is `poster-<slug>-*` and every
   custom property is `--poster-<slug>-*`. All posters load together on one page, so a bare `.pole` or
   `@keyframes sway` would collide.
4. **Add the stylesheet block** to the end of `../../styles/posters.css`, opened by a marker line
   `/* poster: <slug> (description) */`. One palette in a single `:root` block (the dashboard is
   dark-only: no `prefers-color-scheme` split; hex values live only there, and rules read
   `var(--poster-<slug>-...)`). The sway is a `transform` rotation of at most 4 degrees on the poster's
   sway group (`transform-box: view-box`, origin at the pole's foot), set only under
   `.poster-<slug>--moving` and only inside `@media (prefers-reduced-motion: no-preference)`; add a
   `reduce` block that sets `animation: none`. No transitions, nothing else animated.
5. **Register it:** import the component in `index.js` and append one `{ id, name, Component }` entry
   to `POSTERS`. That is the only edit outside the component file and the stylesheet.

## Existing sessions keep their poster

A session's poster is chosen by rendezvous hashing (`pickPoster` in `ui/bot-bar.js`, with its own salt,
so it is independent of the session's mascot) over the ids in `POSTERS`, so it is a pure function of the
session key and the id list. Adding a poster moves about 1/N of sessions to it (N is the new count); every
other session keeps what it had. Removing one moves only that poster's sessions. Never rename an id:
that counts as a removal plus an addition. Append new entries; do not reorder (the order is only the
display order).

## Checks

```sh
npx prettier --write ui-react/components/posters ui-react/styles/posters.css
npm run lint
node --test test/posters.test.mjs test/bot-bar.test.mjs test/mascots-page.test.mjs
npm test
npx playwright test e2e/bot-bar.spec.js e2e/mascots.spec.js
```

`test/posters.test.mjs` loops over `POSTERS`, so it covers a new entry unchanged: unique ids, names and
namespaces; every key from `AB-1` to `TRIPS-12345`, moving or not, renders one `<text>` with its
`textLength`, `aria-hidden` and no `<title`, `<desc` or `title=`; the stylesheet has one block per
poster with nothing shared, every rendered class has a rule, and the only animation is the sway inside
`no-preference` (still under `reduce`). Then look at it on the **Mascots** tab (a card per poster,
still and swaying, at the bar's size and 2x, with the shortest and the longest key, and on the roaming
preview's bots; it reads `POSTERS`, so a new entry shows up with no page change).
