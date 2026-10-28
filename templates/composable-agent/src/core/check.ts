// What is wrong with a value that fails a schema, in words a caller can act
// on. Shared by everything checked when it arrives: config and inputs.

import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';

/** Each problem with `value` against `schema`, located from `root`, such as `config/retry/max`. */
export function problems(schema: TSchema, value: unknown, root: string): string[] {
  return Value.Errors(schema, value).flatMap((error): string[] => {
    const at = `${root}${error.instancePath}`;
    switch (error.keyword) {
      // The `additionalProperties` error that follows names the field.
      case 'boolean':
        return [];
      case 'additionalProperties':
        return error.params.additionalProperties.map((name) => `${at}/${name} is not a field`);
      case 'enum':
        return [`${at} must be one of ${error.params.allowedValues.join(', ')}`];
      default:
        return [`${at} ${error.message}`];
    }
  });
}
