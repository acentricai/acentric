// A command that could not do what it was asked: what went wrong, and what to do about it.

export class Fail extends Error {
  override readonly name = 'Fail';
  /** What to do next, said after the message. */
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}
