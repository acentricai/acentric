// The template's message input: some text from the user.

import { Type } from 'typebox';

import { messageInput } from './define.js';

export const message = messageInput({
  kind: 'message',
  payload: { text: Type.String({ minLength: 1 }) },
  toUserMessage: ({ text }) => ({ role: 'user', content: [{ type: 'text', text }] }),
});
