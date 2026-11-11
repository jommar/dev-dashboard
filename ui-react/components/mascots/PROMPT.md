# Mascot designer prompt (reproducible)

The brief given to each subagent that produced the mascots in this folder. To regenerate or add a
mascot, dispatch one subagent per designer with the prompt below. Designers must run in parallel and
independently; they write to separate folders.

Designers write their scratch output (`bot.svg.html`, `preview.html`) to a gitignored
`.orchestrator/mascots/<SLUG>/` folder. Nothing from there is committed: once a design is chosen, only
the ported component and its stylesheet block are, following `README.md` in this folder ("Adding a
mascot"). The five shipped mascots were ported that way, so their standalone files are not kept.

## How it was run

| Designer | Model | Effort | Scratch folder (gitignored) |
| -------- | ----- | ------ | --------------------------- |
| A        | Opus  | high   | `dux/`                      |
| B        | Opus  | high   | `wick/`                     |
| C        | Opus  | high   | `glim/`                     |
| D        | Opus  | high   | `pinch/`                    |
| E        | Fable | medium | `pinch-hermit-crab/`        |

Agent tool settings: `subagent_type: general-purpose`, `model: opus` (or `fable`), `effort: high`
(or `medium`). Designers A to D were first briefed without roaming, then sent the roaming requirement
as a follow-up message; designer E got the merged brief below. The hover reaction was added later:
after the five designs were ported to React, each designer was resumed with a short brief (the
"REACT" paragraph below plus a pointer to its own component and stylesheet block) and wrote its
reaction to a scratch CSS file, which the lead merged into the stylesheet. The merged brief below
includes hover from the start, so a new designer needs no follow-up. The brief below is the one to
reuse.

## Lessons from the first run (fold these into the next run)

- **Folder collisions.** Two designers both chose "Wick" and wrote into the same folder, and two chose
  "Pinch" (a hermit crab each). Fix: assign each designer its own folder slug up front, and give each a
  different seed or "do not draw: <list of concepts already taken>".
- **Size.** Several mascots came out over the 8 KB aim (Dux about 9 KB core, Pinch-Fable about 8.4 KB),
  mainly from the walk cycle. Say "hard limit 8 KB for the SVG+CSS, excluding the roaming wrapper".
- **Verification.** The designers only checked their markup as text. Ask them to open
  `preview.html` in a browser (Playwright) and report console errors, or have the lead do it.
- **Hover must not replace state animation.** Name the pitfall in the brief (done above), and check it:
  hover each bot in each state and confirm the state's own animation keeps running underneath.
- **Hover at a visible size.** A 56px screenshot is too small to judge a reaction; look at the 160px
  version, or the Mascots page, when checking hover.
- **Designer quirks.** Resumed designers keep their context, so a follow-up can be short. The reaction
  CSS came in around 1 KB each (Dux and Pinch slightly over); that is fine, say "about 1 KB".

## The prompt

Replace `<SLUG>` with the designer's own folder name (assign it; do not let designers choose).
Replace `<TAKEN>` with the concepts other designers already have.

```text
You are one of several independent designers. Design an animated SVG mascot for a developer
dashboard's bottom bar. You decide what the character is and how it looks; be bold and distinctive.
The other designers work in parallel, so deliberately avoid the most obvious choice (a generic boxy
retro robot with an antenna), and avoid these concepts, which are taken: <TAKEN>. Pick a concept with
real personality and give it a short name.

The mascot represents ONE AI coding-agent session on a pull request / code review. It has four states:
- working: the agent is actively busy (continuous, tasteful loop)
- idle: alive but waiting for the human (needs attention, quiet but noticeable)
- done: finished successfully (one-time celebratory beat, then rests still)
- failed: ended without delivering (one-time shake/droop beat, then rests still)

The bots also ROAM around the bottom bar:
- working: moves along the bar, with a locomotion cycle (legs, feet, treads, hover wobble or whatever
  suits your character) playing
- idle: wanders slowly, pausing now and then
- done / failed: stay put after their beat
- Provide a facing flip (`bot--left` / `bot--right`, mirroring via transform: scaleX(-1)).

The bots also REACT when the user hovers or keyboard-focuses them (the bar pauses a roaming bot's walk
while it is hovered or focused, so the bot is standing still while the reaction plays):
- Design one small reaction in the character's own voice (a squeak, a snip, a blush-and-hop, a flame
  flaring: charming, not busy). Trigger it on `.bot:hover` and on `:focus-visible > .bot`, because the
  svg sits inside a button.
- Pure CSS, transform and opacity only; it plays once or loops lightly while hovered and settles when
  the pointer leaves.
- It must work in all four states without breaking the state's own animation. State animations use the
  `animation` property on some groups, and a hover rule that sets `animation` on the same group would
  silently replace it. Put the hover animation on a DIFFERENT group or wrapper, or exclude the state in
  the selector. In `done` and `failed` (resting poses) the reaction can be smaller.
- Put it inside `@media (prefers-reduced-motion: no-preference)`; under reduced motion use at most a
  static cue (a slight brightness or opacity change) and say what it is.
- About 1 KB of CSS. If the reaction needs extra SVG elements or wrapper groups, say exactly which.

Hard constraints:
- Pure inline SVG + CSS keyframes. No JS animation, no external libraries, fonts or images.
- The root element carries a state class (`bot--working`, `bot--idle`, `bot--done`, `bot--failed`); all
  motion is driven by CSS from that class. Animate only transform and opacity (plus fill/stroke colour
  changes) so there is no layout shift.
- No hardcoded hex colours inside the SVG artwork except via CSS custom properties with fallbacks,
  e.g. `fill: var(--bot-body, #8a7cff)`. Define the tokens on `:root` as one dark palette (the
  dashboard is dark-only: no light set, no `prefers-color-scheme` split), covering body, accent, and the four state accent colours
  (working, idle=amber, done=green, failed=red).
- State must never be conveyed by colour alone: each state needs a distinct pose/shape/icon too.
  Give the root svg `role="img"` and an `aria-label` naming the state, and do NOT add a `<title>` or
  `<desc>` child (the browser would show it as a native tooltip; the dashboard shows its own popup).
- Include a `@media (prefers-reduced-motion: reduce)` block that stops every animation and leaves a
  clear still pose per state; under reduced motion the roaming bots stand still at spread-out positions.
- The mascot must read clearly at about 56px tall and still look good at 160px. Blink the eyes (or
  equivalent) on a slow cycle in every state for life.
- Keep it light: hard limit 8 KB for the mascot SVG+CSS (the roaming wrapper CSS is extra).

Deliverables, written under .orchestrator/mascots/<SLUG>/ in the dev-dashboard repo (create it):
1. `bot.svg.html`: the reusable snippet (one `<style>` block + one `<svg>` using a `bot--STATE`
   class), so it can be ported into a React component later. Any roaming-wrapper CSS goes in a
   separate, clearly labelled `<style>` block.
2. `preview.html`: a standalone dark page showing all four states side by side at 56px and 160px, a
   short caption per state (including what the hover reaction does), and a demo strip: a fake bottom
   bar with 4 to 5 bots (mixed states) roaming back and forth with CSS-only translateX keyframes
   (different durations/delays per bot, facing flipped at each turnaround, synchronised to the
   keyframes). Bots in the strip pause and show their hover reaction on hover. Open with no server
   (file://).
Do not touch any other files in the repo. Do not run npm or git commands. Open preview.html in a
browser if you can and fix any console errors; otherwise sanity-check the markup by reading it back.

When finished, return ONLY: the folder path, the concept name, and a one-line description of the
character. No prose summary.
```

## After the designers finish

1. Verify each preview in a browser (no console errors, all four `bot--STATE` classes present, no
   horizontal scroll).
2. Pick the design to ship and port it by following `README.md` in this folder ("Adding a
   mascot"). Only the component and its stylesheet block are committed; `.orchestrator/` stays local.
