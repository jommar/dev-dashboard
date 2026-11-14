// ticket-link.js — the address of a ticket on My Tickets (#/my-tickets?ticket=KEY), and the key an
// address or a typed text names. Mirrors chatHref / chatSessionFromQuery in chat-stream.js.

const KEY = /^[A-Z][A-Z0-9]*-\d+$/i;

// The upper-cased key of a text that is exactly one ticket key (spaces around it are dropped), or null.
export const ticketFromText = (text) => {
  const key = String(text ?? '').trim();
  return KEY.test(key) ? key.toUpperCase() : null;
};

// The ticket a query string names (`ticket=TAP-12`), or null for none or junk.
export const ticketFromQuery = (query) => ticketFromText(new URLSearchParams(query).get('ticket'));

export const ticketHref = (key) => `#/my-tickets?ticket=${key}`;
