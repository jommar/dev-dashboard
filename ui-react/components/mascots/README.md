# Mascots

Animated SVG characters, one per agent session. `index.js` exports `MASCOTS`, the only list of them:
the bar, the dashboard's **Mascots** tab (every entry in all four states, for viewing and picking) and
any picker read it, and none of them hard-code an id or a count.

## Adding a mascot

1. **Design it.** Run the prompt in `PROMPT.md` (this folder). Each designer writes
   `bot.svg.html` (one `<style>`, one `<svg>`) and a `preview.html` to a gitignored
   `.orchestrator/mascots/<slug>/` folder; that scratch is never committed.
2. **Port the SVG** to `<Name>Bot.jsx` in this folder. Copy an existing one. The contract:
   - a named export, wrapped in `memo` so a parent's once-a-second re-render does not restart the
     one-time done and failed animations;
   - props `{ state, facing = 'right', label }`, plus `moving` if the design has a walk cycle.
     `state` is `'working' | 'waiting' | 'done' | 'failed'`; `waiting` is the design's idle pose;
     `facing` is `'left' | 'right'` and is applied as a class, not by the caller;
   - renders only the `<svg>` (`role="img"` and an `aria-label`; never a `<title>`, `<desc>` or `title` attribute, which the
     browser would show as a native tooltip; the dashboard shows its own popup), no wrapper or
     positioning;
   - the class list comes from `botClass(slug, state, facing, ...)` and the name from
     `botLabel(Name, state, label)` in `mascot-support.js`.
3. **Namespace everything.** Pick a one-word lowercase slug (usually the id; no hyphens, so no
   namespace is ever a prefix of another). Every class is `bot-<slug>` or `bot-<slug>-*`, state
   classes are `.bot-<slug>--working|idle|done|failed`, every `@keyframes` is `bot-<slug>-*` and every
   custom property is `--bot-<slug>-*`. The five mascots load together on one page, so a bare `.bot`,
   `.glow` or `@keyframes blink` would collide.
4. **Add the stylesheet block** to the end of `../../styles/mascots.css`, opened by a marker line
   `/* mascot: <slug> (description) ... */`. Keep one palette in a single `:root` block: the dashboard is
   dark-only (`color-scheme: dark`, no theme switch), so use the dark colours and no
   `prefers-color-scheme` split (hex values live only there; rules read `var(--bot-<slug>-...)`), reuse
   the dashboard's `--amber`, `--green` and `--red` for the state colours, and keep a
   `prefers-reduced-motion` block that stops motion and leaves a still pose
   per state. Size with `height: 56px; width: auto; aspect-ratio: W/H` so callers resize by `height`.
5. **Give it a hover/focus reaction**: about 1 KB of CSS in the same stylesheet block, following the
   "REACT" paragraph of `PROMPT.md` (this folder). Trigger it on `.bot-<slug>:hover` and
   `:focus-visible > .bot-<slug>` (the svg sits inside a button), put it inside
   `@media (prefers-reduced-motion: no-preference)`, and animate a different group or an added wrapper
   group from the one a state animation uses, because an `animation` set on the same group would
   silently replace the state's. Under reduced motion give a still cue only (opacity or `filter`).
   `test/mascots.test.mjs` checks all three.
6. **Register it:** import the component in `index.js` and append one `{ id, name, Component }` entry
   to `MASCOTS`. That is the only edit outside the component file and the stylesheet.

## Existing sessions keep their mascot

A session's mascot is chosen by rendezvous hashing over the ids in `MASCOTS`, so it is a pure function
of the session and the id list. Adding a mascot moves about 1/N of sessions to it (N is the new count);
every other session keeps what it had. Removing one moves only that mascot's sessions. Never rename
an id: that counts as a removal plus an addition. Append new entries; do not reorder (the order is
only the display order).

## Checks

```sh
npx prettier --write ui-react/components/mascots ui-react/styles/mascots.css
npm run lint
node --test test/mascots.test.mjs
npm test
```

`test/mascots.test.mjs` loops over `MASCOTS`, so it covers a new entry unchanged: unique ids, names
and namespaces; every state and facing renders with `role="img"` and an `aria-label` and no `<title`, `<desc` or `title=`; the stylesheet has one block
per mascot, nothing shared between blocks, every rendered class has a rule, and each mascot has a
hover/focus reaction that stays inside `no-preference`, leaves the state animations alone and has a still
reduced-motion cue. Then hover it and look at it on the
**Mascots** tab of the dashboard (every registered mascot in all four states at 56px and 160px, with
facing, moving and replay controls and a roaming preview; it reads `MASCOTS`, so a new entry shows up
with no page change).
