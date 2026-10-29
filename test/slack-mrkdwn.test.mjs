// slack-mrkdwn.test.mjs — Slack mrkdwn → render tokens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSlackText } from '../ui/slack-mrkdwn.js';

const text = (value) => ({ type: 'text', text: value });

// The concatenated text of a token list, recursing into emphasis children, so a
// test can still assert "the message reads as …" without caring about nesting.
const flatten = (tokens) =>
  tokens
    .map((token) => (Array.isArray(token.children) ? flatten(token.children) : token.text))
    .join('');

test('plain text is one token and keeps its newlines', () => {
  assert.deepEqual(parseSlackText('the build is green'), [text('the build is green')]);
  // The dialog renders with white-space: pre-wrap, so the newline has to survive
  // inside the text token rather than becoming a separate token.
  assert.deepEqual(parseSlackText('line one\nline two'), [text('line one\nline two')]);
});

test('bold, italic and strike markers become their own tokens', () => {
  assert.deepEqual(parseSlackText('*bold*'), [{ type: 'bold', children: [text('bold')] }]);
  assert.deepEqual(parseSlackText('_italic_'), [{ type: 'italic', children: [text('italic')] }]);
  assert.deepEqual(parseSlackText('~strike~'), [{ type: 'strike', children: [text('strike')] }]);
  assert.deepEqual(parseSlackText('*bold* _italic_ ~strike~'), [
    { type: 'bold', children: [text('bold')] },
    text(' '),
    { type: 'italic', children: [text('italic')] },
    text(' '),
    { type: 'strike', children: [text('strike')] },
  ]);
  const spaced = parseSlackText('a *b c* d');
  assert.deepEqual(spaced, [text('a '), { type: 'bold', children: [text('b c')] }, text(' d')]);
  assert.equal(flatten(spaced), 'a b c d');
});

test('a link inside bold stays a link child, not raw mrkdwn', () => {
  const tokens = parseSlackText(
    '*Spec and plan are up as one draft PR, <https://github.com/TransActComm/ezat-specs/pull/15|ezat-specs#15> (labelled spec and plan)*',
  );
  assert.equal(tokens.length, 1);
  const [bold] = tokens;
  assert.equal(bold.type, 'bold');
  const links = bold.children.filter((child) => child.type === 'link');
  assert.deepEqual(links, [
    {
      type: 'link',
      text: 'ezat-specs#15',
      url: 'https://github.com/TransActComm/ezat-specs/pull/15',
    },
  ]);
  assert.equal(
    flatten(tokens),
    'Spec and plan are up as one draft PR, ezat-specs#15 (labelled spec and plan)',
  );
  // The mrkdwn spelling must not survive anywhere: no angle brackets reach the DOM.
  assert.doesNotMatch(JSON.stringify(tokens), /[<>]/);
});

test('mentions and channels inside emphasis resolve to their own child tokens', () => {
  assert.deepEqual(parseSlackText('*ping <@U1> please*', { U1: 'Patrick Rivera' }), [
    {
      type: 'bold',
      children: [text('ping '), { type: 'mention', text: '@Patrick Rivera' }, text(' please')],
    },
  ]);
  assert.deepEqual(parseSlackText('_ask in <#C0123|general>_'), [
    {
      type: 'italic',
      children: [text('ask in '), { type: 'channel', text: '#general' }],
    },
  ]);
});

test('inline code inside emphasis stays a code child', () => {
  assert.deepEqual(parseSlackText('_run `npm test` now_'), [
    {
      type: 'italic',
      children: [text('run '), { type: 'code', text: 'npm test' }, text(' now')],
    },
  ]);
  assert.deepEqual(parseSlackText('~<https://x/y|PR> was `merged`~'), [
    {
      type: 'strike',
      children: [
        { type: 'link', text: 'PR', url: 'https://x/y' },
        text(' was '),
        { type: 'code', text: 'merged' },
      ],
    },
  ]);
});

test('emphasis does not nest: inner markers stay literal and recursion stops', () => {
  assert.deepEqual(parseSlackText('*a _b_ c*'), [{ type: 'bold', children: [text('a _b_ c')] }]);
  assert.deepEqual(parseSlackText('_a *b* c_'), [{ type: 'italic', children: [text('a *b* c')] }]);
  // Every marker of every kind appears in the body: nothing recurses, so the
  // output is one emphasis token whose text is the untouched payload.
  for (const raw of ['*_~x~_*', '~*_x_*~', '_*~x~*_']) {
    const tokens = parseSlackText(raw);
    assert.equal(tokens.length, 1, `${raw} is one token`);
    assert.equal(tokens[0].type, { '*': 'bold', _: 'italic', '~': 'strike' }[raw[0]]);
    assert.deepEqual(tokens[0].children, [text(raw.slice(1, -1))], `${raw} keeps its body literal`);
  }
});

test('inline code and code fences keep their content verbatim', () => {
  assert.deepEqual(parseSlackText('run `npm test` now'), [
    text('run '),
    { type: 'code', text: 'npm test' },
    text(' now'),
  ]);
  assert.deepEqual(parseSlackText('```\n*bold?*\n```'), [
    { type: 'codeblock', text: '\n*bold?*\n' },
  ]);
  // Nothing inside a fence may be re-tokenised as formatting.
  const fenced = parseSlackText('```\nconst x = *a* _b_ ~c~;\n```');
  assert.equal(fenced.length, 1);
  assert.equal(fenced[0].type, 'codeblock');
  assert.equal(fenced[0].text, '\nconst x = *a* _b_ ~c~;\n');
});

test('links keep their URL and default their label to it', () => {
  assert.deepEqual(parseSlackText('<https://example.com/x|the PR>'), [
    { type: 'link', text: 'the PR', url: 'https://example.com/x' },
  ]);
  assert.deepEqual(parseSlackText('<https://example.com/x>'), [
    { type: 'link', text: 'https://example.com/x', url: 'https://example.com/x' },
  ]);
  // A scheme that is not safe in an href stays literal text.
  assert.deepEqual(parseSlackText('<javascript:alert(1)|click>'), [
    text('<javascript:alert(1)|click>'),
  ]);
});

test('mentions resolve through the names map and fall back to the raw id', () => {
  const names = { U9: 'You', U1: 'Patrick Rivera' };
  assert.deepEqual(parseSlackText('hi <@U1>', names), [
    text('hi '),
    { type: 'mention', text: '@Patrick Rivera' },
  ]);
  assert.deepEqual(parseSlackText('<@U9>', names), [{ type: 'mention', text: '@You' }]);
  assert.deepEqual(parseSlackText('<@U404>', names), [{ type: 'mention', text: '@U404' }]);
  // An unresolved mention may still carry its own label.
  assert.deepEqual(parseSlackText('<@U404|Ghost>', names), [{ type: 'mention', text: '@Ghost' }]);
  // The names map wins over the label Slack shipped.
  assert.deepEqual(parseSlackText('<@U1|patrick>', names), [
    { type: 'mention', text: '@Patrick Rivera' },
  ]);
  assert.deepEqual(parseSlackText('<!here> <!channel> <!everyone>'), [
    { type: 'mention', text: '@here' },
    text(' '),
    { type: 'mention', text: '@channel' },
    text(' '),
    { type: 'mention', text: '@everyone' },
  ]);
});

test('channel references become channel tokens', () => {
  assert.deepEqual(parseSlackText('see <#C0123|general>'), [
    text('see '),
    { type: 'channel', text: '#general' },
  ]);
  assert.deepEqual(parseSlackText('<#C0123>'), [{ type: 'channel', text: '#C0123' }]);
});

test('Slack entities are decoded before tokenising', () => {
  assert.deepEqual(parseSlackText('a &amp; b'), [text('a & b')]);
  assert.deepEqual(parseSlackText('&lt;b&gt; &quot;c&quot; &#39;d&#39;'), [text('<b> "c" \'d\'')]);
  // "&amp;lt;" is the escaped spelling of the literal text "&lt;".
  assert.deepEqual(parseSlackText('&amp;lt;'), [text('&lt;')]);
});

test('unmatched markers, stray backticks and unknown angle brackets stay literal', () => {
  for (const raw of [
    '*not bold',
    '_not italic',
    '~not strike',
    'a `not code',
    '`',
    'plain <not a link> text',
    '2*3*4',
    'snake_case_name',
    '**',
  ]) {
    assert.deepEqual(parseSlackText(raw), [text(raw)], `${raw} stays literal text`);
  }
});

test('empty and non-string input yields no tokens', () => {
  for (const input of ['', null, undefined, 42, {}, [], true]) {
    assert.deepEqual(parseSlackText(input), []);
  }
  assert.deepEqual(parseSlackText('', {}), []);
});

test('mixed content keeps every part and its order', () => {
  const tokens = parseSlackText('TAP-1: *done* <https://x/y|PR> <@U1>\nnext', { U1: 'You' });
  assert.deepEqual(tokens, [
    text('TAP-1: '),
    { type: 'bold', children: [text('done')] },
    text(' '),
    { type: 'link', text: 'PR', url: 'https://x/y' },
    text(' '),
    { type: 'mention', text: '@You' },
    text('\nnext'),
  ]);
  assert.equal(flatten(tokens), 'TAP-1: done PR @You\nnext');
});
