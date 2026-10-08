import { CircularProgress } from '@mui/material';

export function Spinner({ label = 'Loading…', testId = 'loading-spinner' }) {
  return (
    <div className="spinner-wrap" role="status" aria-live="polite" data-testid={testId}>
      <CircularProgress size={14} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
