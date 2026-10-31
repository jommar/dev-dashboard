import { timeAgo } from '../../../ui/dom.js';

export function RelativeTime({ iso, ...props }) {
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()} {...props}>
      {timeAgo(iso)}
    </time>
  );
}
