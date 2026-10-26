// Assistant messages as each provider writes them, for the readers.

import type { AssistantMessage } from '../src/index.js';

/** An OpenAI reply: reasoning, commentary, the answer, and calls of every kind. */
export const openai: AssistantMessage<'openai'> = {
  role: 'assistant',
  provider: 'openai',
  api: 'openai-responses',
  model: 'gpt-6.1-sol',
  id: 'resp_1',
  content: [
    {
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: 'Reading the file first.' }],
      encrypted_content: 'gAAAA...',
    },
    {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      phase: 'commentary',
      content: [{ type: 'output_text', text: 'Looking now.', annotations: [] }],
    },
    {
      type: 'message',
      id: 'msg_2',
      role: 'assistant',
      status: 'completed',
      phase: 'final_answer',
      content: [
        { type: 'output_text', text: 'It is ', annotations: [] },
        { type: 'output_text', text: 'fixed.', annotations: [] },
        { type: 'refusal', refusal: 'I will not delete the tests.' },
      ],
    },
    {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_read',
      name: 'read',
      arguments: '{"path":"a.ts"}',
      namespace: 'files',
      caller: { type: 'program', caller_id: 'prog_1' },
    },
    {
      type: 'custom_tool_call',
      id: 'ctc_1',
      call_id: 'call_patch',
      name: 'patch',
      input: '*** Begin',
    },
    { type: 'shell_call', id: 'sh_1', call_id: 'call_shell', status: 'completed' },
    { type: 'shell_call_output', id: 'sho_1', call_id: 'call_shell', output: 'ok' },
    {
      type: 'mcp_approval_request',
      id: 'apr_1',
      server_label: 'github',
      name: 'merge',
      arguments: '{}',
    },
    { type: 'tool_search_call', id: 'ts_1', call_id: 'call_search', execution: 'server' },
  ],
};

/** A Fireworks reply: reasoning text and one function call. */
export const fireworks: AssistantMessage<'fireworks'> = {
  role: 'assistant',
  provider: 'fireworks',
  api: 'openai-responses',
  model: 'accounts/fireworks/models/kimi-k3',
  content: [
    {
      type: 'reasoning',
      id: 'rs_1',
      summary: [],
      content: [{ type: 'reasoning_text', text: 'thinking' }],
    },
    {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Done.', annotations: [] }],
    },
    {
      type: 'function_call',
      call_id: 'call_1',
      name: 'bash',
      arguments: '{"command":"ls"}',
    },
  ],
};

/** An Anthropic reply: thinking, text split around a citation, a server tool, and two calls. */
export const anthropic: AssistantMessage<'anthropic'> = {
  role: 'assistant',
  provider: 'anthropic',
  api: 'anthropic-messages',
  model: 'claude-sonnet-5-5',
  content: [
    { type: 'thinking', thinking: 'Check the docs.', signature: 'sig' },
    { type: 'thinking', thinking: '', signature: 'sig2' },
    { type: 'redacted_thinking', data: 'encrypted' },
    { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'x' } },
    { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [] },
    { type: 'text', text: 'The answer is ' },
    { type: 'text', text: '42', citations: [{ type: 'web_search_result_location' }] },
    { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a.ts' } },
    {
      type: 'tool_use',
      id: 'toolu_2',
      name: 'screenshot',
      input: {},
      toolset_name: 'computer',
    },
  ],
};
