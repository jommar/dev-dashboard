function hasReason(snapshot, reason) {
  return Array.isArray(snapshot?.partialReasons) && snapshot.partialReasons.includes(reason);
}

export function slackStandaloneMentionWarning(snapshot) {
  return hasReason(snapshot, 'ambiguous_search_result') ||
    hasReason(snapshot, 'ambiguous_history_mention')
    ? 'Some recent standalone mentions may be missing.'
    : '';
}

export function slackStaleReplyWarning(snapshot) {
  return hasReason(snapshot, 'reply_activity_stale') ? 'Reply information may be stale.' : '';
}

// What the screens that list Slack threads (Slack, My Tickets) share about a snapshot that may be
// incomplete: the two reason-specific sentences ('' when the reason is absent) and whether the
// snapshot itself says so (partial, truncated, or either sentence). Each screen adds its own
// causes to `incomplete` (Slack: replies still being checked, a stale update, threads it cannot
// place; My Tickets: a continuation) and words its own note.
export function slackCoverage(snapshot) {
  const staleReplyWarning = slackStaleReplyWarning(snapshot);
  const standaloneWarning = slackStandaloneMentionWarning(snapshot);
  return {
    staleReplyWarning,
    standaloneWarning,
    incomplete: !!(
      snapshot?.partial ||
      snapshot?.truncated ||
      staleReplyWarning ||
      standaloneWarning
    ),
  };
}
