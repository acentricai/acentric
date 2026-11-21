// A provider on the Responses format, made from its profile.

import type { ProviderFields } from '@acentric/protocol';

import { post } from '../http.ts';
import type { CredentialType, Provider, RunnerSettings } from '../provider.ts';
import type { ModelRunner } from '../runner.ts';
import { httpFailure } from './errors.ts';
import type { ResponsesProfile } from './profile.ts';
import { outputText, reasoningSummary, toolCalls } from './read.ts';
import { buildBody } from './request.ts';
import { readAnswer } from './response.ts';
import { assemble } from './stream.ts';

export function responsesRunner(profile: ResponsesProfile, settings: RunnerSettings): ModelRunner {
  return {
    async run(step, signal) {
      const answer = await post({
        label: profile.label,
        provider: profile.id,
        url: profile.url,
        headers: profile.headers(settings.credential),
        body: buildBody(step, profile),
        signal,
        streamed: profile.streams,
        ...(settings.fetch === undefined ? {} : { fetch: settings.fetch }),
      });
      if (answer.status < 200 || answer.status >= 300) throw httpFailure(profile, answer);
      const response = profile.streams
        ? assemble(answer.text, profile.id, profile.label)
        : answer.body;
      return readAnswer(step, response, profile);
    },
  };
}

export function responsesProvider(
  profile: ResponsesProfile,
  more: {
    readonly credentials: readonly CredentialType[];
    readonly defaultModel: string;
    parseOptions(given: unknown): ProviderFields;
  },
): Provider {
  return {
    id: profile.id,
    label: profile.label,
    credentials: more.credentials,
    models: profile.models,
    defaultModel: more.defaultModel,
    parseOptions: (given) => more.parseOptions(given),
    runner: (settings) => responsesRunner(profile, settings),
    read: (message) => ({
      text: outputText(message.content),
      reasoning: reasoningSummary(message.content),
      toolCalls: toolCalls(message.content),
    }),
  };
}
