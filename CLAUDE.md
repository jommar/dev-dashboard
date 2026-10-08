# CLAUDE.md — dev-dashboard

Personal EZAT dev-service dashboard (its own git repo, nested inside the `/ezat` monorepo — not one
of the ticketed TransAct business repos, no `TRIPS` tickets, no graphify graph). See `README.md` for
what it does. This file holds conventions worth knowing before touching the UI layer.

## Formatting and linting agent changes

There is no editor save hook for files edited by an agent, so apply the project's checks explicitly
after making code changes:

- Run Prettier on the changed supported files before finishing (use `npx prettier --write <files>`;
  don't format the entire repository unless asked).
- Run `npm run lint` after code changes and fix all reported issues, including warnings, before
  finishing.
- Run the relevant tests for behavioral changes; run `npm test` when the change may affect broader
  behavior.
- Report any check that could not be run and why.

## UI layout: masonry, not grid, for card lists

Several sections render a variable number of variable-height cards (PR cards, Jira ticket cards,
approval items) grouped under headings. These use real CSS **multi-column masonry** — Pinterest-style
packing — not `display: grid`. Grid lays cards out in strict rows, so if one card in a row is much
taller than its neighbor, everything below that row inherits the dead space; masonry lets a short
column pack the next card up instead.

**The pattern**, applied consistently across `ui/styles/*.css`:

```css
.some-group-container { columns: 1; column-gap: <n>px; }
@media (min-width: 760px)  { .some-group-container { columns: 2; } }
@media (min-width: 1700px) { .some-group-container { columns: 3; } }

.some-card { break-inside: avoid; }          /* required, or a card can split across columns */
.some-card + .some-card { margin-top: <n>px; }  /* inter-item spacing; column layout doesn't collapse margins the way flex/block does */
```

Breakpoints (760px / 1700px, 1 → 2 → 3 columns) are fixed across every surface that uses this pattern,
matching `services.css`'s `.grid` (an explicit-row grid, not masonry, but same breakpoints) so the
whole app feels consistent regardless of which container a given screen width lands in.

**Applied to:**
- `.home-cols` (`ui/styles/home.css`) — Home's three top-level blocks (Sprint, Services, Needs You).
- `.pr-open-groups` (`ui/styles/prs.css`) — the PR tab's main "Open PRs" list, packing `.ticket-card`.
- `.pr-approval-groups` (`ui/styles/prs.css`) — the PR tab's "Needs approval" and "PR merge candidates
  to ops/development" sections, packing `.pr-approval-ticket`.
- `.my-ticket-groups` (`ui/styles/my-tickets.css`) — each category's status-group list on the My
  Tickets tab, packing `.my-ticket-status-group`.

**Not masonry, intentionally:**
- `.home-block` itself (inside `.home-cols`) is `break-inside: avoid` — it's one packed *unit*, not a
  grid of cards, so it never gets its own internal columns (that would split a single ordered action
  queue across columns, which isn't what masonry is for here).
- `services.css`'s `.grid` (Services tab) sets explicit `grid-template-columns` per breakpoint — a
  real multi-column grid, appropriate because service cards are roughly uniform height, not a
  masonry candidate.

**The recurring bug this repo has hit three separate times:** a container styled `display: grid;
gap: <n>px;` with no `grid-template-columns` set. Grid with an unspecified column count collapses to
a single implicit column — so it silently renders as a plain list forever, regardless of viewport,
and any `break-inside: avoid` on its children is a dead declaration (that property only does anything
under multi-column layout, never under grid or flexbox). This is an easy copy-paste mistake: the
`break-inside: avoid` gets added to the card because "that's what masonry cards have," without the
container ever getting the `columns:` half of the pair. **When adding a new card-list container that
should masonry-pack, use the pattern above verbatim — don't reach for `display: grid` and assume it
packs like the others.**

**A second gotcha the same migration can hide:** `display: grid; gap: <n>px;` gives every stacked item
a deterministic gap regardless of layout. `columns:` + `column-gap` only spaces columns *horizontally*
— vertical spacing between two items sharing a column depends entirely on the item's own margin, so
dropping `gap` without adding the `.card + .card { margin-top: <n>px; }` sibling rule silently shrinks
inter-item spacing to whatever margin the card already had (often smaller than the old `gap`). This bit
the `.my-ticket-status-group` migration once already — caught by review, not by any test, since no test
asserted a spacing amount. When migrating a `display: grid` container to `columns:`, add the sibling
margin rule in the same edit, every time, not just for the container you're most focused on.
