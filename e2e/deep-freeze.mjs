// Freezes a value and everything inside it, so a test can prove the code under test never writes to
// its input. Returns the value it was given.
export function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
