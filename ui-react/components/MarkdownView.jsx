// MarkdownView.jsx — Markdown as a reader sees it (headings, lists, task lists, tables, code, links),
// drawn by react-markdown with GitHub-flavoured Markdown. It builds React elements, never an HTML
// string, and raw HTML in the text is not rendered, so a file an agent wrote cannot inject markup.
// The text is untrusted, so two things are narrowed further: a link is live only as an http(s) or
// mailto address (in a new tab, without the opener) or as a link to a sibling file the viewer has
// (`./02-spec.md`: it switches files through `onOpenFile`); any other link shows as plain text. An
// image is never fetched: its alt text shows instead, so opening a plan cannot make the browser call
// out. A flat front-matter block at the top is a quiet metadata row (see ui/markdown-front-matter.js).
import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { splitFrontMatter } from '../../ui/markdown-front-matter.js';

const REMARK_PLUGINS = [remarkGfm];
const SAFE_LINK = /^(?:https?:|mailto:)/i;
const HAS_SCHEME = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const NO_FILES = Object.freeze([]);

// The name of the sibling file a relative link points at, when the viewer has it: `./02-spec.md`,
// `02-spec.md` and `tap-1/02-spec.md#top` all name `02-spec.md`; anything with `..` or a scheme does not.
export function siblingName(href, files) {
  if (!href || HAS_SCHEME.test(href)) return null;
  const path = href.split(/[#?]/)[0];
  if (!path.endsWith('.md') || path.includes('..')) return null;
  const name = path.replace(/^\.\//, '').split('/').pop();
  return files.includes(name) ? name : null;
}

function Image({ alt }) {
  return <span className="markdown-image-off">{alt ? `[image: ${alt}]` : '[image]'}</span>;
}

// A wide table scrolls inside its own box instead of widening the dialog.
function Table({ children }) {
  return (
    <div className="markdown-table-scroll">
      <table>{children}</table>
    </div>
  );
}

export function MarkdownView({ children, files = NO_FILES, onOpenFile, ...props }) {
  const { fields, body } = useMemo(() => splitFrontMatter(children), [children]);
  const components = useMemo(
    () => ({
      a: function Link({ href, children: label }) {
        if (href && SAFE_LINK.test(href))
          return (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {label}
            </a>
          );
        const name = onOpenFile ? siblingName(href, files) : null;
        if (name)
          return (
            <button type="button" className="markdown-file-link" onClick={() => onOpenFile(name)}>
              {label}
            </button>
          );
        return <span className="markdown-link-off">{label}</span>;
      },
      img: Image,
      table: Table,
    }),
    [files, onOpenFile],
  );
  return (
    <div className="markdown-body" {...props}>
      {fields.length > 0 && (
        <dl className="markdown-front-matter" data-testid="markdown-front-matter">
          {fields.map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
        {body}
      </ReactMarkdown>
    </div>
  );
}
