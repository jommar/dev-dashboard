export function parseLines(raw, defaultTailLines) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return defaultTailLines;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : defaultTailLines;
}
