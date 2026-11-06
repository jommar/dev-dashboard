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
