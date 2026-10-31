// slack-notice.test.mjs — the wake notice is one plain line: template text and a link.
import test from 'node:test';
import assert from 'node:assert/strict';

const LINK = 'https://example.slack.com/archives/C024BE91L/p1793192214548389';
const DEFAULT_TEMPLATE = "There's a new message on {link}";
const FIELD = 'slackWatch.noticeTemplate';

async function loadNotice() {
  return import('../backend/slack-notice.mjs');
}

function assertFieldError(result, label) {
  assert.equal(result.ok, false, `${label}: rejected`);
  assert.ok(Array.isArray(result.errors), `${label}: errors is a list`);
  const entry = result.errors.find((error) => error.field === FIELD);
  assert.ok(entry, `${label}: an error names ${FIELD}`);
  assert.equal(typeof entry.code, 'string', `${label}: the error has a code`);
  assert.notEqual(entry.code, '', `${label}: the error code is not empty`);
  assert.equal(typeof entry.message, 'string', `${label}: the error has a message`);
  assert.notEqual(entry.message, '', `${label}: the error message is not empty`);
}

test('the default template renders the sentence with the link', async () => {
  const { renderNotice } = await loadNotice();
  assert.equal(renderNotice(DEFAULT_TEMPLATE, LINK), `There's a new message on ${LINK}`);
});

test('the default template is valid and carries the link placeholder', async () => {
  const { validateNoticeTemplate } = await loadNotice();
  assert.deepEqual(validateNoticeTemplate(DEFAULT_TEMPLATE), { ok: true, missingLink: false });
});

test('a custom template has every link placeholder replaced', async () => {
  const { renderNotice, validateNoticeTemplate } = await loadNotice();
  const template = 'Check {link} now, then read {link} again';
  assert.deepEqual(validateNoticeTemplate(template), { ok: true, missingLink: false });
  assert.equal(renderNotice(template, LINK), `Check ${LINK} now, then read ${LINK} again`);
});

test('replacement patterns in the template or the link stay literal', async () => {
  const { renderNotice } = await loadNotice();
  assert.equal(
    renderNotice('Cost $& and $1 and $$ for {link}', LINK),
    `Cost $& and $1 and $$ for ${LINK}`,
  );
  assert.equal(renderNotice("$' $` {link} $&", LINK), `$' $\` ${LINK} $&`);
  assert.equal(
    renderNotice('See {link}', 'https://example.slack.com/a$&b$1'),
    'See https://example.slack.com/a$&b$1',
  );
});

test('only the link placeholder is substituted', async () => {
  const { renderNotice } = await loadNotice();
  assert.equal(renderNotice('Look at {other} on {link}', LINK), `Look at {other} on ${LINK}`);
  assert.equal(renderNotice('{} {link and {links}', LINK), '{} {link and {links}');
});

test('a template without the link placeholder is valid and flagged for the UI', async () => {
  const { renderNotice, validateNoticeTemplate } = await loadNotice();
  assert.deepEqual(validateNoticeTemplate('Check Slack'), { ok: true, missingLink: true });
  assert.equal(renderNotice('Check Slack', LINK), 'Check Slack');
});

test('a template of exactly 200 characters is accepted', async () => {
  const { validateNoticeTemplate } = await loadNotice();
  assert.deepEqual(validateNoticeTemplate(`${'x'.repeat(194)}{link}`), {
    ok: true,
    missingLink: false,
  });
  assert.deepEqual(validateNoticeTemplate('x'.repeat(200)), { ok: true, missingLink: true });
});

test('a template of 201 characters is rejected with a field error', async () => {
  const { validateNoticeTemplate } = await loadNotice();
  assertFieldError(validateNoticeTemplate(`${'x'.repeat(195)}{link}`), '201 with link');
  assertFieldError(validateNoticeTemplate('x'.repeat(201)), '201 without link');
});

test('a multi-line or control-character template is rejected with a field error', async () => {
  const { validateNoticeTemplate } = await loadNotice();
  const templates = {
    'line feed': 'first {link}\nsecond',
    'carriage return and line feed': 'first {link}\r\nsecond',
    'carriage return': 'first {link}\rsecond',
    'trailing line feed': 'new message on {link}\n',
    tab: 'new\tmessage on {link}',
    'NUL character': 'new message\0 on {link}',
  };
  for (const [label, template] of Object.entries(templates))
    assertFieldError(validateNoticeTemplate(template), label);
});

test('every rendered notice is one line of template text and the link', async () => {
  const { renderNotice, validateNoticeTemplate } = await loadNotice();
  const cases = [
    { template: DEFAULT_TEMPLATE, expected: `There's a new message on ${LINK}` },
    { template: '{link}', expected: LINK },
    { template: 'Ping: {link} / {link}!', expected: `Ping: ${LINK} / ${LINK}!` },
    { template: 'No placeholder here', expected: 'No placeholder here' },
    { template: `${'y'.repeat(194)}{link}`, expected: `${'y'.repeat(194)}${LINK}` },
  ];
  for (const { template, expected } of cases) {
    assert.equal(validateNoticeTemplate(template).ok, true, `${template.slice(0, 20)} is valid`);
    const notice = renderNotice(template, LINK);
    assert.equal(notice, expected);
    assert.doesNotMatch(notice, /[\r\n]/, 'a notice never spans lines');
  }
});
