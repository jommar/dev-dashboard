import { useInsertionEffect, useLayoutEffect, useRef } from 'react';

// Scroll places are read and written by data-testid, the one handle that survives a re-render
// that replaces an element. Both ways of keeping a place (usePreservedInteraction here,
// useSectionScroll for a board's views) go through these two, so they cannot drift apart.

// The place of each element, keyed by its test id, as [top, left].
export function readScroll(elements) {
  return new Map(
    [...elements].map((element) => [
      element.dataset.testid,
      [element.scrollTop, element.scrollLeft],
    ]),
  );
}

// Puts places from readScroll back on the elements with the same test id. An element the places
// do not mention is set to `fallback` ([top, left]) when one is given and left alone otherwise.
export function writeScroll(elements, places, fallback) {
  for (const element of elements) {
    const place = places.get(element.dataset.testid) ?? fallback;
    if (place) [element.scrollTop, element.scrollLeft] = place;
  }
}

const withTestId = (root) => root.querySelectorAll('[data-testid]');
const isScrolled = (element) => element.scrollTop || element.scrollLeft;

export function usePreservedInteraction(root) {
  const places = useRef(new Map());
  useInsertionEffect(() => {
    if (root.current) places.current = readScroll([...withTestId(root.current)].filter(isScrolled));
  });
  useLayoutEffect(() => {
    if (root.current) writeScroll(withTestId(root.current), places.current);
  });
}
