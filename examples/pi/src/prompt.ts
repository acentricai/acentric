// The system prompt: pi's default prompt for its four tools, without the
// parts that come from files (SYSTEM.md, AGENTS.md and the like) or that
// describe pi itself. It is a pure function of the working directory, so
// step and the llm handler build the same text.

import { TOOLS } from './tools.js';

const PREAMBLE =
  'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.';

export function systemPrompt(cwd: string): string {
  const tools = TOOLS.map((tool) => `- ${tool.name}: ${tool.snippet}`).join('\n');
  const rules = [
    // pi adds this when bash is on and grep, find and ls are not.
    'Use bash for file operations like ls, rg, find',
    ...TOOLS.flatMap((tool) => tool.guidelines),
    'Be concise in your responses',
    'Show file paths clearly when working with files',
  ];
  const sections = {
    tools: `${tools}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.`,
    rules: rules.map((rule) => `- ${rule}`).join('\n'),
    cwd: cwd.replace(/\\/g, '/'),
  };
  return [
    PREAMBLE,
    ...Object.entries(sections).map(([name, text]) => `<${name}>\n${text}\n</${name}>`),
  ].join('\n\n');
}
