// The inputs part's config: when a message that arrives during a turn
// reaches the model, if it does not say.

import { Type } from 'typebox';
import type { Static } from 'typebox';

/**
 * When a message that arrives during a turn reaches the model. A message
 * that arrives while idle starts a turn, whatever it says.
 *   - steer: at the model's next call, after the current tool results, so
 *     it can change the turn in progress.
 *   - queue: once the turn ends, as the start of the next turn.
 */
export const Delivery = Type.Enum(['steer', 'queue']);
export type Delivery = Static<typeof Delivery>;

export const InputsConfig = Type.Object({
  inputs: Type.Optional(
    Type.Object(
      {
        /** The delivery of a message that names none. Defaults to steer. */
        defaultDelivery: Type.Optional(Delivery),
      },
      { additionalProperties: false },
    ),
  ),
});
export type InputsConfig = Static<typeof InputsConfig>;
