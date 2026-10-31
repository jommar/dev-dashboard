// slack-notice.mjs — the wake notice is one plain line: template text and a validated link.
//
// `{link}` is the only placeholder. Nothing from Slack can reach the notice, because the
// template is the user's own text and the link comes from the link parser.

const LINK_PLACEHOLDER = '{link}';
const MAX_TEMPLATE_LENGTH = 200;
// Control characters, plus the two Unicode separators some viewers draw as a line break.
const LINE_BREAKING = /[\p{Cc}\u2028\u2029]/u;

// A replacer function keeps `$&` and friends in the template or the link literal.
export const renderNotice = (template, link) => template.replaceAll(LINK_PLACEHOLDER, () => link);

export function validateNoticeTemplate(text) {
  if (typeof text !== 'string' || text.length > MAX_TEMPLATE_LENGTH || LINE_BREAKING.test(text))
    return {
      ok: false,
      errors: [
        {
          field: 'slackWatch.noticeTemplate',
          code: 'INVALID_TEMPLATE',
          message: `Notice must be one line of at most ${MAX_TEMPLATE_LENGTH} characters.`,
        },
      ],
    };
  return { ok: true, missingLink: !text.includes(LINK_PLACEHOLDER) };
}
