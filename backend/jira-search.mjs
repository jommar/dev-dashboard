// Shared accepted-item cap for My Tickets and Releases. Callers own transport,
// mapping and errors; raw page leftovers still make a capped result truncated.
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
