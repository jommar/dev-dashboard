# Claude prompt overrides

This folder holds local overrides for the dashboard's Claude launcher. This README is a guide,
not a prompt: only the eleven exact filenames below are registered. Overrides (including nested
contents) stay gitignored; this guide is the only tracked file here.

## Templates and placeholders

The shared editor, prompt API and `npm run claude:prompts` use this registry order:

| File                   | Replaces                                                | Supported placeholders                                           |
| ---------------------- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| `investigate.md`       | Investigate and plan launch                             | `{KEY}`, `{SLUG}`, `{STATUS_FILE}`                               |
| `implement.md`         | Implement plan launch                                   | `{KEY}`, `{SLUG}`, `{STATUS_FILE}`                               |
| `answers.md`           | Saved/resend planning answers message                   | `{KEY}`, `{SLUG}`, `{STATUS_FILE}`, `{QUESTION_IDS}`, `{CHANGE}` |
| `answers-implement.md` | Saved implement answers message                         | `{KEY}`, `{SLUG}`, `{STATUS_FILE}`, `{QUESTION_IDS}`, `{CHANGE}` |
| `approve.md`           | Approve plan message                                    | `{KEY}`, `{SLUG}`, `{STATUS_FILE}`                               |
| `continue.md`          | Continue message to a failed workflow session           | `{KEY}`, `{SLUG}`, `{STATUS_FILE}`                               |
| `rereview.md`          | Continuation message to an existing code review session | `{KEY}`, `{SLUG}`                                                |
| `groom.md`             | Groom ticket launch                                     | `{KEY}`, `{SLUG}`                                                |
| `review.md`            | New code review session, including Start new review     | `{KEY}`, `{SLUG}`                                                |
| `spec-review.md`       | Spec review launch                                      | `{KEY}`, `{SLUG}`, `{PR}`                                        |
| `e2e.md`               | E2E ticket check launch                                 | `{KEY}`, `{SLUG}`, `{PORT}`                                      |

- `{KEY}` is the validated ticket key; `{SLUG}` is its lowercase form, used for the
  `.orchestrator/` folder name.
- `{STATUS_FILE}` is the absolute path to the ticket's `status.json`. Keep the workflow's
  question and completion-flag protocol when customizing its prompts.
- `{QUESTION_IDS}` lists new or changed answer IDs joined with `, `. `{CHANGE}` is `answers`
  for a normal send with no prior successful answer send for that phase's session,
  `changed answers` for a later normal send with new or changed answers, and `answers (sent again)`
  for an explicit resend (`resend: true`), which only the planning lane has, whether or not the
  answers changed.
- `{PR}` is the validated spec PR number. `{PORT}` is the running browser's port (9300-9399),
  read from the DevTools registry, never from client-supplied prompt text or a client port.

`continue.md` is what **Continue** sends to a workflow session that ended without finishing. The
built-in `groom.md` asks for `Readiness: READY`, `Readiness: NEEDS_INFO` or `Readiness: BLOCKED` as
the first line of `groom.md` (the report), which the dashboard shows as a chip; an existing
`prompts/groom.md` keeps its own text and shows no chip until it asks for that line.

Only the placeholders listed for each template are substituted; others remain literal.
`review.md` is not the continuation message: that is `rereview.md`, never `re-review.md`.

## Question phase tags

The four question-writing prompts (`investigate.md`, `implement.md`, `answers.md` and
`answers-implement.md`) must keep the dashboard's question protocol. Every **new** question has
exactly the keys `id`, `question`, `answer` and `phase`: `investigate.md` and `answers.md` write
`"phase": "investigate-and-plan"`, while `implement.md` and `answers-implement.md` write
`"phase": "implement-plan"`. Every existing question is preserved as it is, including one with no
`phase`, and an answered question's id, text, answer and phase never change. The session never
fills in an answer itself. A new question without the tag is read and counted as a planning one,
so dropping it changes routing; rewriting existing questions can lose or invent answers the
dashboard trusts.

`implement.md` takes its decisions from `02-plan.md`, `02-checklist.md` and `02-spec.md`, which are
the single source of truth, and not from the `answer` fields in the status file. The built-in
`implement.md` commits in the worktree on its own branch and never pushes or opens a pull request; a
custom file keeps its own wording.

`answers-implement.md` is the continuation message for a question the implement session asked. It
continues the approved implementation and its verification with the latest decisions, appends any
new blocker tagged `implement-plan`, and sets only `"implement-plan": true`. It applies only the
answers to implement questions (`"phase": "implement-plan"`); every other decision comes from the
plan, checklist and spec. It never redirects to the planning approval gate. It commits the changes
in the worktree on its own branch and never pushes or opens a pull request.

## Edit, apply and reset

- **In the app:** open a ticket's Claude dialog in My Tickets, then **Prompts** in its footer.
  The existing shared editor lists all eleven templates; the separate review dialog has no editor
  button. **Save** writes the corresponding file; **Reset to default** removes it. Reopen the
  editor to pick up hand edits made while it was open; saving uses the last writer's text.
- **By hand:** create or edit one of the files above in this folder. Optionally run
  `npm run claude:prompts` from the repository root to write all eleven built-in starters with
  placeholders intact. The command keeps every existing override unchanged.
- **Default:** a missing override uses the original built-in text. Delete the override or use
  **Reset to default** to restore it. Existing overrides are never automatically upgraded: if you
  customized `investigate.md`, `implement.md` or `answers.md`, add the phase-tag instruction from
  its built-in text by hand. `answers-implement.md` and `continue.md` are new optional override
  names; without the file the built-in message is used.
- **After a default changes, update your override.** Your `prompts/*.md` files are local, gitignored
  state that the dashboard never edits. When a built-in prompt changes (for example the plan, checklist
  and spec as the single source of truth and the local commit in `implement.md` and
  `answers-implement.md`, or the `Readiness:` line in `groom.md`), hand-edit the matching override or
  press **Reset to default** in the Prompts editor.
- **Application:** files are reread on the next launch or send, with no dashboard restart.
  Editing a file does not change a session's already-delivered prompt. The editor and prompt
  API use the same files as hand edits.
- **Format:** UTF-8 text, trimmed before use, nonempty, no NUL bytes, at most 20,000 JavaScript
  string units after trimming (an emoji counts as two). An unreadable, non-regular, empty,
  oversized or NUL-containing file refuses the launch/send with `prompt_unreadable`; it does
  **not** silently fall back. The editor marks it `unusable file` and shows built-in text for
  repair, not as the text the launcher will use.

## Keep unattended and safety instructions explicit

A custom file replaces the **entire** template after substitution. The dashboard does not
automatically prepend an unattended reminder, security directions or the built-in text.
For unattended custom prompts, include a reminder such as:

> This is an unattended background session. Nobody will answer questions in chat or through a
> question tool. Report blockers instead of waiting, and do not bypass required permissions or
> confirmations.

Keep the task's output paths, workflow status protocol, treatment of untrusted ticket/PR content
and publishing restrictions where needed. This is a recommendation for custom text, not a change
to any built-in prompt or a claim that every built-in uses that reminder.

Spec review's enforced CLI tool/MCP/read restrictions remain in force regardless of custom text.
Its COMMENT-only review, Slack destination and other prompt-only publishing instructions are
**not** automatically included in an override. E2E browser validation and automatic stopping
are unchanged; keep the browser session/attachment and report instructions in custom E2E text
if you need the default behavior. See the root [README](../README.md#custom-prompts) for the full
launch and security contracts.
