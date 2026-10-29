// slack-mrkdwn.js — Slack mrkdwn → render tokens.
//
// Slack's mrkdwn is not Markdown: *bold* and _italic_ swap meaning, <…> carries
// links, mentions and channels, and text arrives with its entities escaped.
// This module exists so the UI can render a thread without innerHTML: every
// construct becomes a typed token that React maps to an element, and anything
// unrecognised comes back as literal text, so a parser gap can never silently
// delete part of a message. Emphasis tokens carry their body as child tokens,
// so "<https://…|the PR>" inside *bold* stays a link rather than raw mrkdwn.
// DOM-free, so it is unit-testable under node:test.

const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

// One pass, so "&amp;lt;" decodes to the literal text "&lt;" and not to "<".
const ENTITY = /&(?:amp|lt|gt|quot|#39);/g;

function decodeEntities(text) {
  return text.replace(ENTITY, (entity) => ENTITIES[entity]);
}

const MARKERS = { '*': 'bold', _: 'italic', '~': 'strike' };

// Slack only honours a marker pair when the opener is not glued to the end of a
// word and the closer is not glued to the start of one. Without that rule every
// snake_case identifier would lose its underscores.
function canOpen(source, index) {
  const before = index === 0 ? '' : source[index - 1];
  const after = source[index + 1];
  if (!after || /\s/.test(after)) return false;
  return !(before && /[A-Za-z0-9]/.test(before));
}

function findClose(source, start, marker) {
  for (let index = start + 2; index < source.length; index += 1) {
    if (source[index] !== marker) continue;
    const before = source[index - 1];
    const after = source[index + 1];
    if (!before || /\s/.test(before)) continue;
    if (after && /[A-Za-z0-9]/.test(after)) continue;
    return index;
  }
  return -1;
}

// Only schemes that are safe in an href: anything else (javascript:, data:) is
// left as literal text rather than handed to the browser as a link.
const LINK_SCHEME = /^(?:https?|mailto):/i;

function parseAngle(inner, names) {
  if (inner.startsWith('@')) {
    const [id, label] = inner.slice(1).split('|');
    if (!id) return null;
    return { type: 'mention', text: `@${names?.[id] || label || id}` };
  }
  if (inner.startsWith('#')) {
    const [id, label] = inner.slice(1).split('|');
    if (!id) return null;
    return { type: 'channel', text: `#${label || id}` };
  }
  if (inner.startsWith('!')) {
    const [word, label] = inner.slice(1).split('|');
    if (!['here', 'channel', 'everyone'].includes(word)) return null;
    return { type: 'mention', text: `@${label || word}` };
  }
  const [url, ...label] = inner.split('|');
  if (!url || !LINK_SCHEME.test(url)) return null;
  // A label may itself contain "|", so everything after the first one is label.
  return { type: 'link', text: label.join('|') || url, url };
}

// The body of an emphasis pair is parsed again so a link, mention, channel or
// inline code keeps its own token instead of leaking its mrkdwn spelling into
// the emphasis text. `emphasis` is false one level down: Slack does not render
// `*a _b_ c*`, so the inner markers are ordinary characters there, and the
// depth limit also guarantees the recursion terminates.
function parseInline(source, names, emphasis) {
  const tokens = [];
  let literal = '';

  const flush = () => {
    if (literal) tokens.push({ type: 'text', text: literal });
    literal = '';
  };
  const push = (token) => {
    flush();
    tokens.push(token);
  };

  let index = 0;
  while (index < source.length) {
    const char = source[index];

    if (char === '`') {
      // A fence is a block construct, so it has no meaning inside an emphasis
      // span; it is only recognised at the top level.
      if (emphasis && source.startsWith('```', index)) {
        const end = source.indexOf('```', index + 3);
        if (end !== -1) {
          push({ type: 'codeblock', text: source.slice(index + 3, end) });
          index = end + 3;
          continue;
        }
      }
      // Inline code stays on one line; a stray backtick must not swallow the
      // rest of a multi-line message.
      const end = source.indexOf('`', index + 1);
      if (end > index + 1 && !source.slice(index + 1, end).includes('\n')) {
        push({ type: 'code', text: source.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
      literal += char;
      index += 1;
      continue;
    }

    if (char === '<') {
      const end = source.indexOf('>', index + 1);
      if (end !== -1) {
        const token = parseAngle(source.slice(index + 1, end), names);
        if (token) {
          push(token);
          index = end + 1;
          continue;
        }
      }
      literal += char;
      index += 1;
      continue;
    }

    const type = MARKERS[char];
    if (emphasis && type && canOpen(source, index)) {
      const end = findClose(source, index, char);
      if (end !== -1) {
        push({
          type,
          children: parseInline(source.slice(index + 1, end), names, false),
        });
        index = end + 1;
        continue;
      }
    }

    literal += char;
    index += 1;
  }

  flush();
  return tokens;
}

export function parseSlackText(text, names = {}) {
  if (typeof text !== 'string' || text === '') return [];
  return parseInline(decodeEntities(text), names, true);
}
