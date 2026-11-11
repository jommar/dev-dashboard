import { Tooltip as MuiTooltip } from '@mui/material';

export function Tooltip({ title, children, ...props }) {
  return (
    <MuiTooltip title={title} {...props}>
      {children}
    </MuiTooltip>
  );
}
