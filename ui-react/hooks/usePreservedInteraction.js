import { useInsertionEffect, useLayoutEffect, useRef } from 'react';

export function usePreservedInteraction(root) {
  const positions = useRef([]);
  useInsertionEffect(() => {
    const element = root.current;
    if (!element) return;
    positions.current = [...element.querySelectorAll('[data-testid]')]
      .filter((item) => item.scrollTop || item.scrollLeft)
      .map((item) => [item.dataset.testid, item.scrollTop, item.scrollLeft]);
  });
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    for (const [testId, top, left] of positions.current) {
      const item = [...element.querySelectorAll('[data-testid]')].find(
        (candidate) => candidate.dataset.testid === testId,
      );
      if (item) {
        item.scrollTop = top;
        item.scrollLeft = left;
      }
    }
  });
}
