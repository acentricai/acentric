// What `acentric init` and `acentric add` write.

/** The versions a new project starts with, as this repository has them. */
export const VERSIONS = { zod: '^4.6.7', esbuild: '0.28.2', typescript: '^7.0.2' } as const;

export function agentFile(name: string): string {
  return `import { Agent } from '@acentric/agent';

export default new Agent({
  provider: 'anthropic',
  instructions: 'You are ${name}.',
});
`;
}

export const TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      // An agent runs where every JavaScript runtime does: no Node of its own.
      lib: ['ES2023', 'DOM'],
      types: [],
    },
    include: ['**/*.ts'],
    exclude: ['node_modules', 'vendor'],
  },
  null,
  2,
)}\n`;

export const GITIGNORE = 'node_modules/\n.env\n';
