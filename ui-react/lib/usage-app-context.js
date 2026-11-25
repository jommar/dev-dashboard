import { createContext, useContext } from 'react';

// Optional base URL of the local usage app (from GET /api/config), used by Sessions drawer token links.
export const UsageAppContext = createContext('');
export const useUsageAppUrl = () => useContext(UsageAppContext);
