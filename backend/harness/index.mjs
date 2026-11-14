// harness/index.mjs — the registry: the only list of harnesses, the default, the metadata that leaves
// the backend and the helpers for the `harness` stamp on a record. Nothing outside backend/harness/<id>/
// imports an adapter except this file (test/harness-layout.test.mjs).
import claudeCode from './claude-code/index.mjs';
import { HARNESS_ID, assertHarness, assertSessions } from './contract.mjs';

// The sessions service of a harness, checked to have every method the generic code calls.
export const buildSessions = (harness, options) =>
  assertSessions(harness.createSessions(options), harness.id);

export const DEFAULT_HARNESS_ID = 'claude-code';
export const HARNESSES = Object.freeze([claudeCode]);

HARNESSES.forEach(assertHarness);

export const harnessById = (id) => HARNESSES.find((harness) => harness.id === id) ?? null;
export const defaultHarness = () => harnessById(DEFAULT_HARNESS_ID);

// What `GET /api/config` carries. Capabilities are derived from the facets, never declared.
export const harnessMeta = (harness) => ({
  id: harness.id,
  label: harness.label,
  name: harness.name,
  command: harness.command,
  capabilities: { chat: Boolean(harness.chat), usage: Boolean(harness.usage) },
});

// The harness a stored record belongs to: its `harness` when that is a valid id, else Claude Code (a
// record written before there were harnesses has none).
export const harnessIdOf = (record) =>
  typeof record?.harness === 'string' && HARNESS_ID.test(record.harness)
    ? record.harness
    : DEFAULT_HARNESS_ID;

// What a new record carries to name its harness: nothing for the default, so Claude Code writes the
// bytes it always wrote.
export const harnessStamp = (harness) =>
  harness.id === DEFAULT_HARNESS_ID ? {} : { harness: harness.id };
