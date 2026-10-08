import * as api from '../lib/api.js';

// Stable, domain-free API surface for panel hooks and component adapters.
export function useDashboardApi() {
  return api;
}
