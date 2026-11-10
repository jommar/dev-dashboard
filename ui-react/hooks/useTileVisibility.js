import { useEffect, useState, useSyncExternalStore } from 'react';

// Whether `ref`'s element is inside the viewport, or inside whatever scrolling pane clips it. The
// margin starts a tile just before it scrolls into view. Without IntersectionObserver every tile
// counts as in view, so nothing is ever left paused for lack of an observer.
export function useInView(ref, margin = '48px') {
  const [inView, setInView] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(
      (entries) => setInView(entries.at(-1).isIntersecting),
      { rootMargin: margin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, margin]);
  return inView;
}

const onVisibility = (listener) => {
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
};
const isVisible = () => document.visibilityState !== 'hidden';

// False while this page is in a background tab or minimised, when nobody can see a tile.
export const useDocumentVisible = () => useSyncExternalStore(onVisibility, isVisible, () => true);
