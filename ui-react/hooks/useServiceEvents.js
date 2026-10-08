import { useEffect, useState } from 'react';
import { onSetupRequired, subscribeServices } from '../lib/api.js';

export function useServiceEvents(enabled, handleSetupRequired) {
  const [services, setServices] = useState(null);
  const [connection, setConnection] = useState('connecting');
  useEffect(() => {
    if (!enabled) {
      setServices(null);
      setConnection('connecting');
      return undefined;
    }
    const stream = subscribeServices(setServices, setConnection);
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
