import {
  Alert,
  Button as MuiButton,
  Card as MuiCard,
  CircularProgress,
  Paper,
} from '@mui/material';
import { Tooltip } from './Tooltip.jsx';

export function Button({ className = '', variant = 'outlined', ...props }) {
  const { hidden, tabIndex, ...rest } = props;
  return (
    <MuiButton
      className={`btn ${className}`.trim()}
      variant={variant}
      size="small"
      sx={hidden ? { display: 'none' } : undefined}
      tabIndex={tabIndex ?? 0}
      {...rest}
    />
  );
}

export function Card({ children, className = '', ...props }) {
  const { component = 'div', ...rest } = props;
  return (
    <MuiCard component={component} className={`card ${className}`.trim()} elevation={0} {...rest}>
      {children}
    </MuiCard>
  );
}

export function Panel({ children, className = '', ...props }) {
  return (
    <Paper component="section" className={`panel ${className}`.trim()} elevation={0} {...props}>
      {children}
    </Paper>
  );
}

export function LoadingState({ label = 'Loading…', testId = 'loading-spinner' }) {
  return (
    <div className="spinner-wrap" role="status" aria-live="polite" data-testid={testId}>
      <CircularProgress size={14} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({ children, testId, onRetry }) {
  return (
    <Alert
      severity="error"
      data-testid={testId}
      action={onRetry ? <Button onClick={onRetry}>Try again</Button> : undefined}
    >
      {children}
    </Alert>
  );
}

export function Pill({ children, className = '', ...props }) {
  return (
    <span className={`pill ${className}`.trim()} {...props}>
      {children}
    </span>
  );
}

export function DashboardTooltip({ title, children, ...props }) {
  return (
    <Tooltip title={title} {...props}>
      {children}
    </Tooltip>
  );
}
