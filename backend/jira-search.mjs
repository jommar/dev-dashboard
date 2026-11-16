// Shared helpers for paged and pooled upstream reads: the accepted-item cap for My Tickets, Releases
// and the Sprint tab, and a small worker pool. Callers own transport, mapping and errors.

// Runs `work` over `items` with at most `limit` in flight. A worker takes no next item once
// `stopped()` is true, so a caller that sets its flag on a failure ends the reads still queued.
export async function runWithLimit(items, limit, work, stopped = () => false) {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stopped()) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// Raw page leftovers still make a capped result truncated.
export async function collectCappedJiraIssues({ fetchPage, mapIssue, maxIssues }) {
  const items = [];
  let truncated = false;
  let nextPageToken = null;
  for (;;) {
    const data = await fetchPage(nextPageToken);
    const issues = data.issues || [];
    const lastPage = data.isLast || !data.nextPageToken;
    for (const [index, issue] of issues.entries()) {
      const mapped = mapIssue(issue);
      if (mapped) items.push(mapped);
      if (items.length >= maxIssues) {
        truncated = index < issues.length - 1 || !lastPage;
        break;
      }
    }
    if (items.length >= maxIssues || lastPage) return { items, truncated };
    nextPageToken = data.nextPageToken;
  }
}
