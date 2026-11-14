import { useMemo } from 'react';
import { BoardNote } from './BoardShell.jsx';
import { useUpstreamHealth } from '../hooks/useUpstreamHealth.js';
import { degradedNotes } from '../../ui/upstream-health.js';

// One amber board note per degraded integration the screen depends on (`integrations`, in order),
// nothing when all are healthy or the health read has not answered. Pass the board's `active` and a
// `refreshKey` that changes when it refreshes.
export function UpstreamNote({ integrations, active = true, refreshKey }) {
  const health = useUpstreamHealth({ active, refreshKey });
  // Worded once per health answer: the board re-renders every second, and a "retry in 41 s" that
  // changed text each time would be re-announced by the note's live region every second.
  const names = integrations.join(',');
  const notes = useMemo(() => degradedNotes(health, names.split(','), Date.now()), [health, names]);
  if (!notes.length) return null;
  return (
    <>
      {notes.map(({ name, testId, text }) => (
        <BoardNote key={name} testId={testId}>
          {text}
        </BoardNote>
      ))}
    </>
  );
}
