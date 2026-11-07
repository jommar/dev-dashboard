// What the Watch threads tab shows while another view is selected: how many threads are watched
// and, when the watcher needs a look, one sentence saying why (disabled, paused, or a delivery
// that failed, in that order of precedence). `watch` is the watch list the card polls, or null
// before its first read, when there is nothing to show yet.
const FAILED = new Set(['failed-transient', 'failed-permanent']);

export function slackWatchSummary(watch) {
  if (!watch) return { count: undefined, attention: '' };
  const links = watch.links ?? [];
  const failing = links.some((link) =>
    link.sessions.some(({ delivery }) => FAILED.has(delivery?.status)),
  );
  const attention =
    watch.state === 'disabled'
      ? 'Watcher disabled'
      : watch.state === 'paused'
        ? 'Watcher paused'
        : failing
          ? 'A delivery is failing'
          : '';
  return { count: links.length, attention };
}
