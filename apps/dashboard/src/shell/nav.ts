// The sidebar's sections, in order. A tab shows only to a person who may use it; a section left
// with no tabs goes.

import { agentsSection } from '../agents/index.ts';
import { machinesSection } from '../machines/index.ts';
import type { Me } from '../me.ts';
import type { Section, Tab } from '../sections.ts';

export const SECTIONS: readonly Section[] = [agentsSection, machinesSection];

/** The sections and tabs this person sees. */
export function visibleSections(
  me: Me | undefined,
  sections: readonly Section[] = SECTIONS,
): Section[] {
  if (me === undefined) return [];
  return sections
    .map((section) => ({ ...section, tabs: section.tabs.filter((tab) => tab.shown(me)) }))
    .filter((section) => section.tabs.length > 0);
}

/** The first tab this person sees: where `/` goes. */
export function firstTab(
  me: Me | undefined,
  sections: readonly Section[] = SECTIONS,
): Tab | undefined {
  return visibleSections(me, sections)[0]?.tabs[0];
}

/** Whether `pathname` is on `tab`: its page, or one below it. */
export function onTab(pathname: string, tab: Tab): boolean {
  return pathname === tab.path || pathname.startsWith(`${tab.path}/`);
}

/** The tab, of any section, that `pathname` is on. */
export function tabAt(
  pathname: string,
  sections: readonly Section[] = SECTIONS,
): { tab: Tab; section: Section } | undefined {
  for (const section of sections) {
    for (const tab of section.tabs) if (onTab(pathname, tab)) return { tab, section };
  }
  return undefined;
}
