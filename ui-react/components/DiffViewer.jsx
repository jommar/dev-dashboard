import { openDiffViewer } from '../../ui/components/diff-viewer.js';

export function DiffViewer({ repo, number, children = 'View diff', testId }) {
  return (
    <button
      type="button"
      className="btn subtle icon-btn view-diff"
      data-repo={repo}
      data-number={number}
      data-testid={testId}
      aria-label="View diff vs origin/ops/development"
      onClick={(event) => openDiffViewer(event.currentTarget)}
    >
      {children}
    </button>
  );
}
