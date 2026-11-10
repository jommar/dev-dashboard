// Shared GraphQL wire plumbing only: callers own batching and response/error policy.
export function headers(tokenStr) {
  return {
    Authorization: `Bearer ${tokenStr}`,
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dev-dashboard',
  };
}

// The selection includes its own whitespace so each caller retains its query body.
export function pullRequestQuery(prs, selectionForPr) {
  const aliases = prs.map((pr, index) => {
    const [owner, repo] = pr.repo.split('/');
    return (
      `a${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) {\n` +
      `pullRequest(number: ${pr.number}) {${selectionForPr(pr, index)}}\n}`
    );
  });
  return `query {\n${aliases.join('\n')}\n}`;
}

export async function postGraphql(config, query) {
  return fetch(`${config.github.api}/graphql`, {
    method: 'POST',
    redirect: 'error',
    headers: headers(config.credentials.githubToken),
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(15_000),
  });
}
