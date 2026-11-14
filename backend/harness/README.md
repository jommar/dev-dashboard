# Harnesses

The dashboard launches, lists, resumes, stops and chats with coding-agent sessions. Everything that
speaks a harness's CLI sits behind one adapter object, so a second harness is one directory here plus
one registry line, not a hunt through the launcher, chat, usage and UI code. Claude Code is the first
adapter, `claude-code`, the default and the only one registered: with it active the dashboard behaves as
it always did (same argument arrays, command strings, files, routes, reply shapes, reason codes and
words).

`index.mjs` exports `HARNESSES`, the only list of harnesses. The launcher, the chat, the usage reader,
the Slack watcher and the UI read it through the registry and hard-code no id or count.

```
backend/harness/
  index.mjs          the registry: HARNESSES, the default id, harnessMeta, harnessIdOf, harnessStamp
  contract.mjs       assertHarness: the shape check every registered adapter passes at load
  session-entry.mjs  stateOf, settleSession (generic, over the session entry)
  session-lock.mjs   createSessionLock: the one-writer mark every sessions service builds on
  claude-code/
    index.mjs        the adapter object; composes the files below
    sessions.mjs     createClaudeSessions, homeReadable (the sessions service)
    chat-items.mjs   liveMessages, historyItems (stream-json line and transcript to items)
    cli.mjs          the binary, the chat turn's argument array, the attach and resume commands
    usage.mjs        parseLine: one transcript line to { id, model, tokens }
    spec-review.mjs  the spec review's tool limits and MCP config file
```

The generic modules keep their `claude-` names (`claude-launcher.mjs`, `claude-chat.mjs`,
`claude-ticket-state.mjs`, `claude-usage.mjs`, ...): the name is the product area, not the harness.

## The contract

An adapter is one frozen object, the default export of `backend/harness/<id>/index.mjs`.

| Member                                   | Required | Meaning                                                                                                                                                                       |
| ---------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                     | yes      | Stable id, `^[a-z][a-z0-9-]{0,31}$`. Stored in records: never renamed.                                                                                                        |
| `label`, `name`, `command`               | yes      | Product name for prose (`Claude Code`), short name for sentences (`Claude`), the executable (`claude`); each at most 40 characters.                                           |
| `prompt`                                 | yes      | `{ skill, askTool }`, each at most 40 characters: what the harness calls a named skill and how it asks the human. They fill `{SKILL}` and `{ASK_TOOL}` in the shared prompts. |
| `createSessions(options)`                | yes      | Builds the sessions service. `options` carries at least `store` (the Slack watch store).                                                                                      |
| `homeReadable(home?)`                    | yes      | Whether the harness's own state directory is readable; the Slack watcher stays disabled while it is false.                                                                    |
| `commands.attach(shortId)`               | yes      | Terminal command that joins a live session, or null.                                                                                                                          |
| `commands.resume(sessionId)`             | yes      | Command that continues a finished session, without the workspace `cd`, or null.                                                                                               |
| `chat`                                   | no       | `{ buildTurn, liveMessages, historyItems }`. Absent: no Chat.                                                                                                                 |
| `usage`                                  | no       | `{ parseLine }`. Absent: no token tallies.                                                                                                                                    |
| `limits.specReview({ launchDirectory })` | no       | `{ tools, disallowedTools, mcpConfig }` a spec review launches with. Absent: a spec review is refused, because it must never run unrestricted.                                |

`assertHarness` checks the required members, the id pattern, the text limits and that a present facet
has all of its functions (`limits: {}` is rejected). The registry runs it on every entry when it loads,
so a malformed adapter fails every run. Capabilities are derived from the facets, never declared, so
they cannot disagree with them.

**Sessions service.** `createSessions` returns `entries`, `listSessions`, `launch`, `stop`, `resume`,
`lastActive`, `transcriptFile`, `transcriptFiles`, `recoverSessionIds`, `beginTurn` and `isHeld`, with the
result words the launcher, chat and watcher already rely on (`delivered`, `failed-permanent`,
`failed-transient`, `waiting`, `stopped`, `not_listed`, `not_idle`, and the reasons under
[Claude launcher](../../README.md#routes-and-errors)). An adapter maps its harness onto those words and
adds none. Build the one-writer mark with `createSessionLock()` and `stateOf` / `settleSession` from
`session-entry.mjs`; do not write a second lock. `assertSessions` (`contract.mjs`, run by `buildSessions`
in `index.mjs` where `createHttpHandler` builds the service) throws when one of these methods is
missing; it cannot run in `assertHarness`, because the service is built per server, not at load.

**Session entry.** Every entry `entries()` returns has: `sessionId` (a UUID; an entry without one is
dropped), `id` (the 8 lowercase hex short id, or absent), `name` and `startedAt` (what a launch record
is matched against), `state` (`working`, `blocked`, `done` or `stopped`; anything else reads as
unknown), `pid` (a number while live, `null` with `state: 'stopped'` after a stop, absent when
finished) and `cwd` (used only to resume).

**Chat facet.** `buildTurn({ sessionId, resuming, message })` returns `{ command, args, input }`: the
binary, a fixed argument array that names the session and never holds the message, and the one stdin
line that does. `liveMessages(line, turn)` returns `[{ event, data }]` for one stdout line and sets
`outcome`, `reason`, `error`, `denials` and `costUsd` on `turn` at its result line. `historyItems(text)`
returns `{ items, truncated }` from a transcript (newest branch, at most 300 items). The chat module
keeps the process: `spawn(command, args, { cwd, env: withoutSecrets(process.env) })`, no shell.

**Usage facet.** `parseLine(line)` returns `{ id, model, tokens }` (`tokens` holds `input`, `output`,
`cacheRead` and `cacheCreation`) for a line that carries an API message's usage, else null. The reader
keeps the byte offsets, dedupe by `id`, the model-id check, the 8 MiB budget and the file cache.

## Adding a harness

1. **Make the directory** `backend/harness/<id>/` and write the files the way `claude-code/` splits
   them: a sessions service, the chat files (if it has a chat), a usage parser (if it reports tokens), a
   commands file and `index.mjs`, which freezes and default-exports the adapter object.
2. **Fill the contract above.** Give it the `prompt` words, the sessions service and the two commands first; add `chat`,
   `usage` and `limits.specReview` only when the harness can do them honestly. A missing facet is a
   refusal or an empty answer, never a stub:
   - no `chat`: send, stop and stream are 409 `harness_unsupported`, and the Chat screen's composer is
     read-only with the reason;
   - no `usage`: the usage route answers zero tallies without reading a file, and the UI stops asking;
   - no `limits.specReview`: a spec review launch is 409 `harness_unsupported` before any write.
3. **Keep the process rules.** Every process starts from an argument array, no `shell`, with
   `env: withoutSecrets(process.env)` (`backend/config.mjs` is the one place that lists credential
   names). A message, prompt or notice is never an argument where the harness can read it from stdin or
   after `--`. Nothing a session said, no transcript content, cwd or path is logged: failures go through
   `logClaudeFailure`. Transcript paths come from validated session ids, never from a request.
4. **Respect the import rule.** An adapter imports only Node built-ins, `backend/config.mjs`,
   `backend/claude-log.mjs`, `backend/slack-watch-store.mjs` (for `isSessionId`), the generic files in
   `backend/harness/` and its own directory, never the launcher, chat, ticket state, usage or HTTP
   modules. Nothing outside `backend/harness/<id>/` imports from it except `index.mjs`. Both are pinned
   by `test/harness-layout.test.mjs`.
5. **Register it:** import it in `index.mjs` and append it to `HARNESSES`. That is the only edit outside
   the adapter directory and the test driver. Selection is in code: `DEFAULT_HARNESS_ID` names the
   default, and `createHttpHandler` uses `integrations.harness` when a test or caller passes one. There
   is no setting, environment variable or UI control, and one harness is active per process.
6. **Add a conformance driver.** `test/harness-conformance.test.mjs` loops over `HARNESSES` and fails
   for a registered id without an entry in its `DRIVERS` table. The driver builds the adapter over
   recording fakes (an injected `execFileImpl` / `spawn`, an in-memory home); the suite then asserts the
   contract: `assertHarness`, process starts (`harness.command`, array, no shell, scrubbed env), entry
   shape, result vocabularies, the one-writer mark, commands, `buildTurn` keeping the message out of
   `args`, `parseLine` returning only numbers, and silence on `console`. `test/harness-fake.mjs` is the
   test-only second adapter that proves the seam without another CLI; copy its shape.
7. **Update the docs:** this guide if the contract changed, and the [README](../../README.md#harnesses)
   and `CLAUDE.md` "Harness seam" where they name behaviour.

## One prompt source

The prompts (the built-in texts in `backend/claude-prompts.mjs` and the `prompts/*.md` overrides, see
[Custom prompts](../../prompts/README.md)) are one set for every harness: an adapter adds no prompt
file, directory or template. A word in a prompt that is specific to a harness is a placeholder filled
from the adapter's `prompt` data (`harnessValues`): `{SKILL}` and `{ASK_TOOL}` today. To make another
fragment harness-specific, add the member to `prompt` (and to `assertHarness`, the fake adapter and the
conformance suite) and the placeholder to the prompt; Claude Code must still render byte-identically
(`test/claude-prompts-golden.test.mjs`).

The prompt text still says "skill" in its back-references; a harness whose vocabulary differs accepts
that or has the wording generalized centrally, never a second prompt set.

## Existing records keep their harness

A new phase record in `claude/<KEY>/launch.json` and a new standalone chat record in
`claude/chat/<uuid>.json` carry `harness: <id>` only when the active harness is not `claude-code`
(`harnessStamp`), so Claude Code writes exactly the bytes it always wrote. `harnessIdOf(record)` reads
a record's `harness` when it is a valid id and otherwise `claude-code`, so every file written before
harnesses existed reads as Claude Code, and rolling back the code reads every file Claude Code wrote.

- Never rename an id: it is a stored value, so a rename orphans every record that carries it.
- An action that resumes a recorded session (answers, approve, continue, re-review, a chat send to a
  standalone chat) compares the record's harness to the active one first. A mismatch is 409
  `CLAUDE_REFUSED` with `errors[0]` `harness_unsupported`, before any file write or CLI call: one
  harness never resumes another's session. Such a record still lists, as a session the active listing
  does not hold, but with no go-to command (the active harness's commands would misname it).
- `status.json` is unchanged: it is a protocol with the session, which edits it itself.

## What leaves the backend

`harnessMeta(harness)` is `{ id, label, name, command, capabilities: { chat, usage } }`, and
`GET /api/config` carries it as `harness` beside its existing keys; no other response gains a field.
The UI reads it through `ui/harness.js` (`harnessFrom`, `say`, `can`, `DEFAULT_HARNESS`) and
`ui-react/lib/harness-context.js` (`useHarness`): wording tokens (`{name}`, `{label}`, `{command}`,
`{A}`) are filled from it, a missing or invalid value means Claude Code, and the usage hooks and the
Chat composer follow `capabilities`. Route paths, `CLAUDE_REFUSED` / `CLAUDE_FAILED`, the `[claude]` log
prefix, the `claude/` directory, `listing.source: 'claude'`, `claude_home_unreadable`, hooks, test ids
and CSS classes keep their names on purpose: they name the product area, and tests pin them.

## Not verified, and what is still Claude-shaped

No second real harness is built or tested: the contract is shaped by Claude Code and by what the generic
modules consume. How another CLI lists, resumes or reports sessions is unchecked. The generic modules
still assume these Claude-shaped contracts, which a second adapter must emulate (the seam moved the
Claude literals into the adapter, it did not generalise the vocabulary):

- A harness-listed Slack watch row carries `source: 'claude'` (`slack-watcher.mjs` compares it), a wire
  value meaning "from the harness listing".
- `launch()` takes Claude's option names (`addDir`, `tools`, `disallowedTools`, `mcpConfig`), and
  `limits.specReview` returns `{ tools, disallowedTools, mcpConfig }`.
- Session ids are a UUID (`isSessionId`) and a short id is 8 lowercase hex (`isShortId`) everywhere,
  and the resume go-to is `cd ~/pathwise && <commands.resume(id)>` (`resumeGoTo`).
- A record another harness wrote still lists, but gets no go-to or resume command, and the chat only
  opens its history through the active harness's `historyItems`.

## Checks

`test/config.test.mjs` also scans `backend/harness/**` for any file that imports `child_process` and
requires it to take its environment from `withoutSecrets`, so an adapter that spawns is covered with no
edit.

```sh
npx prettier --write backend/harness test/harness-*.test.mjs test/harness-fake.mjs
npm run lint
node --test test/harness-conformance.test.mjs test/harness-layout.test.mjs test/harness-routes.test.mjs test/harness.test.mjs
npm test
```
