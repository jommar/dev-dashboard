import { useEffect, useState } from 'react';

const TICK_MS = 1000;

// The only 1 s tick for the watch card's countdowns. Reaching zero asks the owner for one refetch
// per due time: the server moves its time on only when its timer runs; the card's poll catches up.
export function Countdown({ iso, label, dueText, onDue, ...props }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const seconds = Math.ceil((Date.parse(iso) - now) / 1000);
  const due = seconds <= 0;
  useEffect(() => {
    if (due) onDue?.();
  }, [due, iso, onDue]);

  return <span {...props}>{due ? dueText : `${label} ${seconds} s`}</span>;
}
