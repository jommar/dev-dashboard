// ServiceActionsMenu.jsx — one Actions button on a service card that opens Start / Stop / Restart.
// The one popup on the card that is not native: MUI Menu renders in a portal, so the card's
// `overflow: hidden` cannot clip it. Escape and the arrow keys come from the Menu.
import { useEffect, useId, useRef, useState } from 'react';
import { Menu, MenuItem } from '@mui/material';
import { Button } from './Primitives.jsx';

const ACTIONS = ['start', 'stop', 'restart'];

export function ServiceActionsMenu({ serviceId, disabled, onAction }) {
  const [anchor, setAnchor] = useState(null);
  const triggerId = useId();
  const listId = useId();
  const trigger = useRef(null);
  const refocus = useRef(false);
  const close = () => setAnchor(null);
  // Choosing an action locks the card in the same render that closes the menu, so the Menu cannot
  // hand focus back to a disabled trigger: take it back once the lock ends.
  useEffect(() => {
    if (disabled || !refocus.current) return;
    refocus.current = false;
    trigger.current?.focus();
  }, [disabled]);
  return (
    <>
      <Button
        ref={trigger}
        id={triggerId}
        className="service-actions-trigger"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={anchor ? 'true' : 'false'}
        aria-controls={anchor ? listId : undefined}
        data-testid={`service-actions-${serviceId}`}
        onClick={(event) => setAnchor(event.currentTarget)}
      >
        Actions
      </Button>
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={close}
        slotProps={{ list: { id: listId, 'aria-labelledby': triggerId } }}
      >
        {ACTIONS.map((action) => (
          <MenuItem
            key={action}
            className={action}
            disabled={disabled}
            data-testid={`${action}-${serviceId}`}
            data-service={serviceId}
            data-action={action}
            onClick={() => {
              refocus.current = true;
              close();
              onAction(action);
            }}
          >
            {action[0].toUpperCase() + action.slice(1)}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
