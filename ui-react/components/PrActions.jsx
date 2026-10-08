import { useEffect, useRef } from 'react';
import { openDiffViewer } from '../../ui/components/diff-viewer.js';

export function PrActions({ children }) {
  const root = useRef(null);
  useEffect(() => {
    const element = root.current;
    const handleClick = (event) => {
      const button = event.target.closest('.view-diff');
      if (button && element.contains(button) && !button.disabled) openDiffViewer(button);
    };
    element?.addEventListener('click', handleClick);
    return () => element?.removeEventListener('click', handleClick);
  }, []);
  return <div ref={root}>{children}</div>;
}
