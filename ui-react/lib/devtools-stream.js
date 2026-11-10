import { createDevtoolsStream } from '../../ui/devtools-stream.js';
import { openDevtoolsStream, subscribeDevtoolsStream, unsubscribeDevtoolsStream } from './api.js';

// This tab's one live-view stream, shared by every tile of the wall and by the viewer.
export const devtoolsStream = createDevtoolsStream({
  open: openDevtoolsStream,
  subscribe: subscribeDevtoolsStream,
  unsubscribe: unsubscribeDevtoolsStream,
});
