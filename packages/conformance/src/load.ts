// Reads the scenario files shipped with this package.

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { Scenario } from './scenario.js';

/** The directory holding the scenario files. */
export const scenariosDir = fileURLToPath(new URL('../scenarios/', import.meta.url));

/** Every scenario, ordered by file name. */
export async function loadScenarios(dir: string = scenariosDir): Promise<Scenario[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith('.json')).toSorted();
  return Promise.all(
    files.map(async (file) => {
      const value: unknown = JSON.parse(await readFile(`${dir}/${file}`, 'utf8'));
      if (!isScenario(value)) throw new Error(`${file} is not a scenario`);
      return value;
    }),
  );
}

function isScenario(value: unknown): value is Scenario {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'name') === 'string' &&
    typeof Reflect.get(value, 'section') === 'string' &&
    Array.isArray(Reflect.get(value, 'steps'))
  );
}
