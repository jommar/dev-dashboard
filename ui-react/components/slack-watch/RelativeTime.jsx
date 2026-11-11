import { timeAgo } from '../../../ui/dom.js';
import { DashboardTooltip } from '../Primitives.jsx';

export function RelativeTime({ iso, ...props }) {
  return (
    <DashboardTooltip title={new Date(iso).toLocaleString()} describeChild>
      <time dateTime={iso} {...props}>
        {timeAgo(iso)}
      </time>
    </DashboardTooltip>
  );
}
