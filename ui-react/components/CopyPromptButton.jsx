// CopyPromptButton.jsx — fetches the ticket's filled prompt from the server and copies it to the
// clipboard, with a brief inline confirmation. Always enabled (even when a launch button is blocked)
// so a prompt can be pasted into another harness.
import { useEffect, useRef, useState } from 'react';
import { Button, DashboardTooltip } from './Primitives.jsx';
import { NavIcon } from './NavIcon.jsx';
import { getClaudePrompt } from '../lib/api.js';
import { copyText } from '../../ui/dom.js';

const COPIED_MS = 2000;

export function CopyPromptButton({
  ticketKey,
  name,
  browserId,
  variant = 'chip',
  label,
  text = 'Copy prompt',
  testId,
  onCopied,
  onCopyFailed,
  onError,
}) {
  const [outcome, setOutcome] = useState(null);
  const busy = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!outcome) return undefined;
    const timer = setTimeout(() => setOutcome(null), COPIED_MS);
    return () => clearTimeout(timer);
  }, [outcome]);

  const copy = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const result = await getClaudePrompt(ticketKey, name, browserId ? { browserId } : undefined);
      if (!mounted.current) return;
      if (!result.ok) {
        setOutcome('Copy failed');
        onError?.(result);
        return;
      }
      const ok = await copyText(result.text);
      if (!mounted.current) return;
      setOutcome(ok ? 'Copied' : 'Copy failed');
      if (ok) onCopied?.(result);
      else onCopyFailed?.(result.text);
    } finally {
      busy.current = false;
    }
  };

  const ok = outcome === 'Copied';
  if (variant === 'icon') {
    return (
      <DashboardTooltip title={outcome ?? label} describeChild>
        <Button
          className="subtle claude-chip claude-copy-icon"
          data-testid={testId}
          aria-label={outcome ?? label}
          onClick={copy}
        >
          <NavIcon name={ok ? 'check' : 'copy'} />
        </Button>
      </DashboardTooltip>
    );
  }
  if (variant === 'button') {
    return (
      <Button
        className="subtle"
        data-testid={testId}
        aria-label={outcome ? undefined : label}
        onClick={copy}
      >
        {outcome ?? text}
      </Button>
    );
  }
  return (
    <Button
      className="subtle claude-chip"
      data-testid={testId}
      aria-label={outcome ? undefined : label}
      onClick={copy}
    >
      <NavIcon name={ok ? 'check' : 'copy'} />
      {outcome ?? text}
    </Button>
  );
}
