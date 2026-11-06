// Slack timestamps are decimal seconds, not floating-point numbers.
export function parseSlackTs(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d+)\.(\d{1,6})$/.exec(value);
  return match ? [BigInt(match[1]), BigInt(match[2].padEnd(6, '0'))] : null;
}
