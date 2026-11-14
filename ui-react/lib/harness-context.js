import { createContext, useContext } from 'react';
import { DEFAULT_HARNESS } from '../../ui/harness.js';

// The active harness (see ui/harness.js), provided by App from GET /api/config. Claude Code outside
// a provider or before the config arrives.
export const HarnessContext = createContext(DEFAULT_HARNESS);
export const useHarness = () => useContext(HarnessContext);
