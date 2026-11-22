// A conversation's messages as a model is sent them, where that is not as they are kept.
//
// A line of the engine's own, such as a notice that a task ended, is kept in the conversation
// as a message of the system, and is sent as one of the user, inside a tag that says whose it
// is. A provider takes a message of the user anywhere a line can come to stand, which it does
// not a message of the system: one refuses a message of the system that follows the model's
// answer. And what a task printed has no claim to the weight of an instruction.
//
// It is the same for every provider, and depends on nothing but the message, so that a
// conversation is sent the same way on every call.

import type { ImagePart, Message, TextPart } from '@acentric/protocol';

/** What every line of the engine's own is put inside when the model is sent it. */
export const NOTICE_TAG = 'system-notice';

const FORGED = new RegExp(`<(/?)${NOTICE_TAG}`, 'gi');
/** The same, for asking whether there is one: `test` on a global pattern keeps its place between calls. */
const HAS_FORGED = new RegExp(`</?${NOTICE_TAG}`, 'i');

/** Text in which the engine's tag cannot be: only the engine writes it, so one written by anyone else is escaped. */
export function unforged(text: string): string {
  return text.replace(FORGED, `&lt;$1${NOTICE_TAG}`);
}

/** A message of the system that is its provider's own, such as a change of the reasoning level: it is sent as it is. */
const isProviderSystem = (message: Message): boolean =>
  message.role === 'system' && message.providerOptions !== undefined;

/** A message as the model is sent it. The same message when it is sent as it is kept. */
export function asSent(message: Message): Message {
  if (message.role === 'user' || message.role === 'tool_result') {
    // A person, or a tool, that writes the engine's tag has it escaped.
    const forged = message.content.some(
      (part) => part.type === 'text' && HAS_FORGED.test(part.text),
    );
    if (!forged) return message;
    return {
      ...message,
      content: message.content.map((part) =>
        part.type === 'text' ? { ...part, text: unforged(part.text) } : part,
      ),
    };
  }
  if (message.role !== 'system' || isProviderSystem(message)) return message;
  // Its images stay where they are, inside the tag. What a task printed is in a line too, and
  // may hold the tag.
  const content: (TextPart | ImagePart)[] = [];
  let text = `<${NOTICE_TAG}>\n`;
  for (const part of message.content) {
    if (part.type === 'text') {
      text += unforged(part.text);
      continue;
    }
    content.push({ type: 'text', text }, part);
    text = '';
  }
  content.push({ type: 'text', text: `${text}\n</${NOTICE_TAG}>` });
  return { role: 'user', content };
}
