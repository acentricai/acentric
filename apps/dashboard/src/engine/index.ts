// The Engine section: the engine's own pages.

import type { AnyRoute } from '@tanstack/react-router';

import type { Section } from '../sections.ts';

function routes(_parent: AnyRoute): AnyRoute[] {
  return [];
}

export const engineSection: Section = { id: 'engine', label: 'Engine', tabs: [], routes };
