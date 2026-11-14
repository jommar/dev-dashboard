// `previous` while `next` holds the same JSON, so a poll or push that found nothing new keeps the
// same object and React skips the render. Compare the whole value, never a projection of it: the
// Services card refreshes its log on every service snapshot, and each log line only changes
// `lineCount` and `lastLineAt`, so a projection that ignored those would freeze live logs.
export const keepIfEqual = (previous, next) =>
  JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
