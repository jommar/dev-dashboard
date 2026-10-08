import { useEffect, useRef } from 'react';
import { Tooltip as MuiTooltip } from '@mui/material';
import { mountTooltip } from '../../ui/components/tooltip.js';

export function Tooltip({ title, children, ...props }) {
  return (
    <MuiTooltip title={title} {...props}>
      {children}
    </MuiTooltip>
  );
}

export function TooltipLayer() {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) mountTooltip(ref.current);
  }, []);
  return <div ref={ref} id="tooltip" className="tooltip" hidden data-testid="tooltip" />;
}
