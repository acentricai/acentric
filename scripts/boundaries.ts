// Which package may depend on which. `boundaries.json` says, for every package of the
// workspace, the workspace packages it may depend on. This file checks the workspace against
// it, and reads nothing itself: `check-boundaries.ts` gives it what it found.
//
// A package cannot import what it does not depend on: pnpm links only what its package.json
// names, and a file outside a package's `src` is outside its project. So checking what each
// package.json names is checking what its code may import.

/** A package of the workspace, as its own files describe it. */
export type Package = {
  readonly name: string;
  /** Its folder, from the repository's root, such as `packages/core`. */
  readonly dir: string;
  /** The workspace packages its package.json depends on, by name. */
  readonly dependencies: readonly string[];
  /** The names it depends on that are workspace packages, but not by a `workspace:` version. */
  readonly unlinked: readonly string[];
  /** The folders its tsconfig.json references, from the repository's root. */
  readonly references: readonly string[];
};

export type Workspace = {
  /** `boundaries.json`: for each package, the packages it may depend on. */
  readonly allowed: { readonly [name: string]: readonly string[] };
  readonly packages: readonly Package[];
  /** The folders the root tsconfig.json references, from the repository's root. */
  readonly rootReferences: readonly string[];
};

/** A cycle in what is allowed, as the names along it, or undefined when there is none. */
function cycleIn(allowed: Workspace['allowed']): readonly string[] | undefined {
  const done = new Set<string>();
  const visit = (name: string, path: readonly string[]): readonly string[] | undefined => {
    const at = path.indexOf(name);
    if (at !== -1) return [...path.slice(at), name];
    if (done.has(name)) return undefined;
    for (const next of allowed[name] ?? []) {
      const cycle = visit(next, [...path, name]);
      if (cycle !== undefined) return cycle;
    }
    done.add(name);
    return undefined;
  };
  for (const name of Object.keys(allowed)) {
    const cycle = visit(name, []);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
}

/** What is wrong with the workspace, one line each. Nothing is wrong when it is empty. */
export function check(workspace: Workspace): string[] {
  const { allowed, packages, rootReferences } = workspace;
  const problems: string[] = [];
  const byName = new Map(packages.map((found) => [found.name, found]));

  for (const [name, may] of Object.entries(allowed)) {
    if (!byName.has(name)) problems.push(`boundaries.json names ${name}, which is not a package`);
    for (const dependency of may) {
      if (!byName.has(dependency)) {
        problems.push(
          `boundaries.json lets ${name} depend on ${dependency}, which is not a package`,
        );
      }
    }
  }
  const cycle = cycleIn(allowed);
  if (cycle !== undefined) problems.push(`boundaries.json has a cycle: ${cycle.join(' → ')}`);

  for (const found of packages) {
    const may = allowed[found.name];
    if (may === undefined) {
      problems.push(`${found.name} (${found.dir}) is not in boundaries.json`);
      continue;
    }
    for (const dependency of found.unlinked) {
      problems.push(
        `${found.name} depends on ${dependency} by a version: it is "workspace:*" here`,
      );
    }
    for (const dependency of found.dependencies) {
      if (!may.includes(dependency)) {
        problems.push(
          `${found.name} depends on ${dependency}, which boundaries.json does not let it`,
        );
      }
    }

    // A project is built after what it references, so it references what it depends on.
    const expected = found.dependencies
      .map((dependency) => byName.get(dependency)?.dir)
      .filter((dir) => dir !== undefined);
    for (const dir of expected) {
      if (!found.references.includes(dir)) {
        problems.push(`${found.dir}/tsconfig.json does not reference ${dir}, which it depends on`);
      }
    }
    for (const dir of found.references) {
      if (!expected.includes(dir)) {
        problems.push(`${found.dir}/tsconfig.json references ${dir}, which it does not depend on`);
      }
    }

    if (!rootReferences.includes(found.dir)) {
      problems.push(`The root tsconfig.json does not reference ${found.dir}, so it is never built`);
    }
  }
  return problems;
}
