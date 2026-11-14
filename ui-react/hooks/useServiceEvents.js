import { useEffect, useState } from 'react';
import { onSetupRequired, subscribeServices } from '../lib/api.js';
import { keepIfEqual } from '../../ui/keep-if-equal.js';

// A snapshot that repeats byte for byte (a settings broadcast, say) keeps the same list, so App and
// the panels do not render for it. Equality is on the whole JSON, never on a projection: every
// service output line changes `lineCount` and `lastLineAt`, and the Services card refreshes its log
// whenever this list changes identity, so the snapshot is the live-log trigger. Two lines inside one
// millisecond with a capped buffer can look identical; the next message catches up.
const keepSnapshot = (list) => (previous) => keepIfEqual(previous, list);

export function useServiceEvents(enabled, handleSetupRequired) {
  const [services, setServices] = useState(null);
  const [connection, setConnection] = useState('connecting');
  useEffect(() => {
    if (!enabled) {
      setServices(null);
      setConnection('connecting');
      return undefined;
    }
    const stream = subscribeServices((list) => setServices(keepSnapshot(list)), setConnection);
    const unsubscribe = onSetupRequired(() => {
      stream.close();
      setServices(null);
      handleSetupRequired();
    });
    return () => {
      unsubscribe();
      stream.close();
    };
  }, [enabled, handleSetupRequired]);
  return { services, connection };
}
