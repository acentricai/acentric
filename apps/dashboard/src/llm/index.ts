// The LLM providers section: the model accounts calls are made with, and what the calls cost.

import type { AnyRoute } from '@tanstack/react-router';

import type { Section } from '../sections.ts';

function routes(_parent: AnyRoute): AnyRoute[] {
  return [];
}

export const llmSection: Section = { id: 'llm', label: 'LLM providers', tabs: [], routes };
