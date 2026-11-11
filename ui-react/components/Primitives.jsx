import { cloneElement, isValidElement } from 'react';
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

// The app's one hover and focus popup. No text, no tooltip, so a conditional hint can be passed
// straight in. `describeChild` keeps the child's own accessible name and makes the popup its
// description (aria-describedby while open); without it the title becomes the child's aria-label
// unless the child sets its own. MUI would also stamp a native `title` on a described child while
// the popup is closed, which the browser shows as a second tooltip, so that one is overridden.
export function DashboardTooltip({ title, children, describeChild, slotProps, ...props }) {
  if (!title) return children;
  const child =
    describeChild && isValidElement(children)
      ? cloneElement(children, { title: undefined })
      : children;
  return (
    <Tooltip
      title={title}
      describeChild={describeChild}
      slotProps={{ transition: { timeout: 0 }, ...slotProps }}
      {...props}
    >
      {child}
    </Tooltip>
  );
}
