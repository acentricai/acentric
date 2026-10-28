// The inputs part's settings: its config with the defaults filled in.

import type { Delivery, InputsConfig } from './config.js';

export type InputsSettings = {
  inputs: { defaultDelivery: Delivery };
};

export const DEFAULT_DELIVERY: Delivery = 'steer';

export function inputsSettings(config: InputsConfig): InputsSettings {
  return { inputs: { defaultDelivery: config.inputs?.defaultDelivery ?? DEFAULT_DELIVERY } };
}
