import { describe, expect, it } from 'vitest';

import { check } from './boundaries.ts';
import type { Package, Workspace } from './boundaries.ts';

/** A package with nothing wrong: it depends on `dependencies`, and references their folders. */
function pkg(name: string, dependencies: readonly string[] = []): Package {
  return {
    name,
    dir: `packages/${name}`,
    dependencies,
    unlinked: [],
    references: dependencies.map((dependency) => `packages/${dependency}`),
  };
}

function workspace(allowed: Workspace['allowed'], packages: readonly Package[]): Workspace {
  return { allowed, packages, rootReferences: packages.map((found) => found.dir) };
}

describe('check', () => {
  it('finds nothing wrong with a workspace that keeps to what is allowed', () => {
    const allowed = { a: [], b: ['a'], c: ['a', 'b'] };
    expect(check(workspace(allowed, [pkg('a'), pkg('b', ['a']), pkg('c', ['b'])]))).toEqual([]);
  });

  it('refuses a dependency that is not allowed', () => {
    const problems = check(workspace({ a: [], b: [] }, [pkg('a'), pkg('b', ['a'])]));
    expect(problems).toEqual(['b depends on a, which boundaries.json does not let it']);
  });

  it('refuses a package boundaries.json does not have', () => {
    const problems = check(workspace({ a: [] }, [pkg('a'), pkg('b')]));
    expect(problems).toEqual(['b (packages/b) is not in boundaries.json']);
  });

  it('refuses a name in boundaries.json that is no package', () => {
    const problems = check(workspace({ a: ['gone'], old: [] }, [pkg('a')]));
    expect(problems).toEqual([
      'boundaries.json lets a depend on gone, which is not a package',
      'boundaries.json names old, which is not a package',
    ]);
  });

  it('refuses a cycle in what is allowed', () => {
    const allowed = { a: ['c'], b: ['a'], c: ['b'] };
    const problems = check(workspace(allowed, [pkg('a'), pkg('b'), pkg('c')]));
    expect(problems).toEqual(['boundaries.json has a cycle: a → c → b → a']);
  });

  it('refuses a workspace package depended on by a version', () => {
    const b = { ...pkg('b', ['a']), unlinked: ['a'] };
    const problems = check(workspace({ a: [], b: ['a'] }, [pkg('a'), b]));
    expect(problems).toEqual(['b depends on a by a version: it is "workspace:*" here']);
  });

  it('refuses a tsconfig.json that does not reference what the package depends on', () => {
    const b = { ...pkg('b', ['a']), references: [] };
    const problems = check(workspace({ a: [], b: ['a'] }, [pkg('a'), b]));
    expect(problems).toEqual([
      'packages/b/tsconfig.json does not reference packages/a, which it depends on',
    ]);
  });

  it('refuses a tsconfig.json that references what the package does not depend on', () => {
    const b = { ...pkg('b'), references: ['packages/a'] };
    const problems = check(workspace({ a: [], b: ['a'] }, [pkg('a'), b]));
    expect(problems).toEqual([
      'packages/b/tsconfig.json references packages/a, which it does not depend on',
    ]);
  });

  it('refuses a package the root tsconfig.json does not build', () => {
    const problems = check({ allowed: { a: [] }, packages: [pkg('a')], rootReferences: [] });
    expect(problems).toEqual([
      'The root tsconfig.json does not reference packages/a, so it is never built',
    ]);
  });
});
