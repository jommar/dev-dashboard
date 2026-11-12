import { timeAgo } from '../../../ui/dom.js';
import { DashboardTooltip } from '../Primitives.jsx';

// `now` (ms) ages the text at that moment instead of the current one, and `title` replaces the popup,
// which is the locale time of `iso` unless given. Both are optional; the other callers pass neither.
export function RelativeTime({ iso, now, title, ...props }) {
  return (
    <DashboardTooltip title={title ?? new Date(iso).toLocaleString()} describeChild>
      <time dateTime={iso} {...props}>
        {timeAgo(iso, now)}
      </time>
    </DashboardTooltip>
  );
}
