# Poster designer prompt (reproducible)

The brief given to each subagent that designs a poster for the bot bar. A poster is a small sign on a
stick that a bot carries; it shows the ticket key the bot's Claude session is working on. Posters are
shared across bots: each session gets one by a stable hash of its session key, so a session keeps its
poster. To add a poster, dispatch one designer with the prompt below, then follow `README.md` in this
folder ("Adding a poster").

Designers write their scratch output (`poster.svg.html`, `preview.html`) to a gitignored
`.orchestrator/posters/<SLUG>/` folder. Only the ported component and its stylesheet block are committed.

## How to run it

Dispatch the designers in parallel and independently. Assign each designer its own `<SLUG>` and a
`<THEME FAMILY>` up front (folder collisions and duplicate concepts happened with the mascots when
designers chose freely). Agent tool settings: `subagent_type: general-purpose`, `model: opus`,
`effort: high`. The first five posters used these families: paper and print, light and electric,
digital and pixel, handmade and craft, and one wildcard.

## The prompt

Replace `<SLUG>` with the designer's own folder name and `<THEME FAMILY>` with its broad family.

```text
You are one of five independent designers. Design ONE animated-ready SVG poster (a small sign on a
stick) that a pixel-sized mascot carries along the bottom bar of a developer dashboard. The poster
shows the ticket key the mascot's AI-agent session works on, e.g. "TAP-1451" or "TRIPS-1877".
Your broad theme family is: <THEME FAMILY>. Within it, pick a concept with real personality and give it
a short name. The other four designers cover the other families; stay inside yours so the five posters
look clearly different from each other.

The poster, from the bar's point of view:
- It is carried on a short pole behind the mascot, centred above its head, so the pole's foot is the
  anchor point. Draw the pole as part of the poster. Total drawn size about 84px wide by 50px tall at
  bar scale (viewBox about 84 x 50; the board about 72 x 30 plus a ~16px pole). It must stay legible
  and look good at 2x.
- The ticket key is the one piece of text. Use an SVG <text> with a monospace stack
  (`ui-monospace, SFMono-Regular, Menlo, monospace`), at least 10px effective, with high contrast
  against the board. Ticket keys run from about 5 to 12 characters ("AB-1" to "TRIPS-12345"), so fit
  the text with `textLength` and `lengthAdjust="spacingAndGlyphs"` to a fixed box width: it must never
  overflow the board for any key. The text content comes from a React prop later; keep it a single
  text node so it can be swapped.
- The poster sways gently from the pole's foot while its mascot walks, and is still otherwise. Provide
  a `poster--moving` class on the root that turns the sway on (a small rotation, around +-4 degrees,
  transform only, slow and soft); without the class it is perfectly still. (The port runs it only
  under `prefers-reduced-motion: no-preference`.) The mascot's facing flip is
  handled outside the poster, so never mirror the text.
- It carries NO state of its own (the mascot shows the state). A very light accent is fine (a tape
  corner, a glow), but nothing animated beyond the sway, and nothing that implies done/failed/working.

Hard constraints:
- Pure inline SVG + CSS. No JS, no external libraries, fonts, images or filters that cost a lot
  (a single drop shadow or glow is fine).
- Animate only transform and opacity. No layout shift.
- No hardcoded hex colours inside the artwork except via CSS custom properties with fallbacks, e.g.
  `fill: var(--poster-board, #f4ead0)`. Define the tokens on `:root` as ONE dark-friendly palette (the
  dashboard is dark-only: no light set, no `prefers-color-scheme` split). The board must read clearly on
  a dark page background.
- Decorative: the poster is hidden from assistive tech (`aria-hidden="true"`, `focusable="false"`); do
  NOT add a `<title>` or `<desc>` (the browser would show it as a native tooltip).
- Include a `@media (prefers-reduced-motion: reduce)` block that removes the sway.
- Every class, keyframe name and custom property starts with `poster-<SLUG>-` / `--poster-<SLUG>-`
  (they all load together later). The root carries `poster-<SLUG>` and the moving modifier is
  `poster-<SLUG>--moving`.
- Keep it light: hard limit 3 KB of SVG + CSS.

Deliverables, written under .orchestrator/posters/<SLUG>/ in the dev-dashboard repo (create it):
1. `poster.svg.html`: the reusable snippet (one `<style>` block + one `<svg>`), with the ticket key
   as a single `<text>` node, so it can be ported into a React component later.
2. `preview.html`: a standalone dark page showing the poster with three keys ("AB-1", "TAP-1451",
   "TRIPS-12345") at 1x and 2x, a swaying (moving) copy and a still copy, and a small stand-in "mascot"
   (a 56px rounded rectangle) holding the pole so the scale and anchor are visible. Open with no
   server (file://).
Do not touch any other files in the repo. Do not run npm or git commands. Open preview.html in a
browser (Playwright) if you can, check it at 2x for overflow with the longest key, and fix any console
errors; otherwise sanity-check the markup by reading it back.

When finished, return ONLY: the folder path, the concept name, and a one-line description of the
poster. No prose summary.
```

## After the designers finish

1. Verify each preview in a browser (no console errors, the longest key fits the board).
2. Port the chosen designs by following `README.md` in this folder ("Adding a poster"). Only the
   component and its stylesheet block are committed; `.orchestrator/` stays local.
