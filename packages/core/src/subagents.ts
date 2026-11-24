// Subagents: an actor spawns another actor, and the two talk by messages.
//
// A subagent is not a task. It is an actor like any other, of an agent the spawning actor's
// agent lists, and it has no end: it is working or idle, and can always be sent more work.
// Spawning one only creates it. What it is to do is the first message it is sent, by the same
// tool as every message after.
//
// Messages go up and down, never across. An actor names the actors it spawned by the names it
// gave them, and the one that spawned it `parent`.

import { schemaToType } from '@earendil-works/pi-codemode';
import type { CodemodeJsonSchema } from '@earendil-works/pi-codemode';

import type {
  Actor,
  ActorId,
  AgentDefinition,
  AgentId,
  Json,
  MachineEnv,
  MachineId,
  Reasoning,
  SystemMessage,
  UserMessage,
} from '@acentric/protocol';

import {
  ActorArchived,
  ActorNotFound,
  AgentNotFound,
  EngineError,
  InvalidConfiguration,
} from './errors.ts';
import type { CallResult } from './executor.ts';
import { issuesText } from './executor.ts';
import { NameTaken } from './store.ts';
import type { OwnTool } from './own-tool.ts';

/** What an actor calls the one that spawned it. No subagent can have it for a name. */
export const PARENT = 'parent';

/** The type of the input a message from an actor's parent is. */
export const AGENT_MESSAGE = 'agent';

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** A message as the actor it is sent to reads it: what was said, and who said it. */
export function wrapMessage(from: string, message: string): string {
  return `<message from="${from}">\n${message}\n</message>`;
}

/** What a subagent's `create` returned: what the new actor is created with. */
type Spawned = {
  /** Absent for the machine of the actor that spawns. Null for none. */
  readonly machine?: {
    readonly id: MachineId;
    readonly cwd: string;
    readonly env?: MachineEnv;
  } | null;
  readonly modelId?: string;
  readonly reasoning?: Reasoning;
  readonly configuration?: Json;
};

/** What the tools are given of the engine they are part of. */
export type SubagentsHost = {
  /** The subagent an actor gave a name, with the call that spawned it. */
  child(
    parent: ActorId,
    name: string,
  ): Promise<{ readonly actor: Actor; readonly spawnedBy: string | null } | undefined>;
  children(parent: ActorId): Promise<Actor[]>;
  /** The agent of a name, and what its active code says of itself. Undefined when there is none. */
  agentNamed(
    name: string,
  ): Promise<{ readonly id: AgentId; readonly definition: AgentDefinition } | undefined>;
  /** Calls a function of the code an actor is on. */
  call(actor: Actor, path: string, argument: Json): Promise<CallResult>;
  /** The variables an actor's commands are run with, opened. */
  envOf(actor: ActorId): Promise<MachineEnv>;
  /** Creates the subagent. Rejects as creating any actor does. */
  create(given: {
    readonly agent: AgentId;
    readonly modelId?: string;
    readonly reasoning?: Reasoning;
    readonly configuration?: Json;
    readonly machine?: { readonly id: MachineId; readonly cwd: string; readonly env?: MachineEnv };
    readonly parent: { readonly id: ActorId; readonly name: string; readonly call: string };
  }): Promise<Actor>;
  /**
   * Puts a message in an actor's mailbox, once for one `id`. `down` is from its parent, and is
   * a message as a person's is. Up is from one of its subagents, and is a notice.
   */
  post(
    to: ActorId,
    mail: { readonly id: string; readonly message: UserMessage | SystemMessage },
  ): Promise<void>;
};

const failed = (text: string) => ({ content: text, isError: true });

const subagentsOf = (definition: AgentDefinition) => definition.subagents ?? [];

export function subagentTools(host: SubagentsHost): OwnTool[] {
  const spawn: OwnTool = {
    tool: {
      type: 'function',
      name: 'spawn_agent',
      description: 'Creates a subagent.',
      parameters: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Which agent it is one of.' },
          name: {
            type: 'string',
            description:
              'What you will call it from now on: letters, digits, _ and -. No two of your subagents have the same name.',
          },
          params: {
            type: 'object',
            description: 'What it is created with, for an agent that takes any: see the agent.',
          },
        },
        required: ['agent', 'name'],
      },
    },
    // Before anything of the same answer is sent to what it creates.
    first: true,
    available: (_actor, definition) => subagentsOf(definition).length > 0,

    describe(_actor, definition) {
      return [
        'Creates a subagent: another agent that works for you, and that you talk with by messages. Creating it gives it nothing to do: it is idle until you send it a message with `message_agent`. It knows nothing of your conversation, and you see nothing of its.',
        '',
        'The agents you can create one of:',
        ...subagentsOf(definition).map((subagent) => {
          const params =
            subagent.schema === undefined
              ? ''
              : `\n  params: ${schemaToType(subagent.schema as CodemodeJsonSchema).replaceAll('\n', '\n  ')}`;
          return `- ${subagent.agent}: ${subagent.description}${params}`;
        }),
      ].join('\n');
    },

    async run(actor, definition, args, call) {
      const { agent: asked, name, params, ...rest } = args;
      const unknown = Object.keys(rest)[0];
      if (unknown !== undefined) return failed(`${unknown} is not known`);
      const listed = subagentsOf(definition);
      const subagent = listed.find((one) => one.agent === asked);
      if (subagent === undefined) {
        return failed(
          `There is no agent ${String(asked)} for you to create one of. There ${listed.length === 1 ? 'is' : 'are'}: ${listed.map((one) => one.agent).join(', ')}`,
        );
      }
      if (typeof name !== 'string' || !NAME.test(name)) {
        return failed('name is 1 to 64 letters, digits, _ or -, starting with a letter or a digit');
      }
      if (name === PARENT) {
        return failed(`${PARENT} is what a subagent calls you: it cannot be one's name`);
      }
      if (
        params !== undefined &&
        (typeof params !== 'object' || params === null || Array.isArray(params))
      ) {
        return failed('params is an object');
      }
      const created = (id: string): string =>
        `Created ${name}, one of ${subagent.agent} (${id}). It is idle until it is sent a message.`;
      const taken = failed(
        `You have a subagent ${name} already. Send it a message with message_agent.`,
      );

      const before = await host.child(actor.id, name);
      if (before !== undefined) {
        // The same call, made again after it was cut off.
        return before.spawnedBy === call.id ? { content: created(before.actor.id) } : taken;
      }

      // What it is created with is the spawning agent's to say.
      let made: Spawned = {};
      if (subagent.creates || params !== undefined) {
        const answer = await host.call(
          actor,
          `subagents.${subagent.agent}.create`,
          (params ?? {}) as Json,
        );
        if (!answer.ok) {
          if (answer.kind === 'invalid') {
            const issues = answer.issues.map((issue) => issuesText([issue]));
            return failed(`The params of ${subagent.agent} are not valid:\n${issues.join('\n')}`);
          }
          const why = answer.kind === 'lost' ? answer.reason : answer.error.message;
          return failed(`${subagent.agent} could not be created: ${why}`);
        }
        made = answer.value as Spawned;
      }

      const agent = await host.agentNamed(subagent.agent);
      if (agent === undefined) {
        return failed(`The agent ${subagent.agent} is not deployed, so none can be created`);
      }
      // Left out, it works where the actor that spawns it does, unless its agent says its
      // actors have no machine. Null is none.
      const onMachine = agent.definition.features?.includes('machine') === true;
      let machine = made.machine;
      if (machine === undefined) {
        machine =
          !onMachine || actor.machine === null
            ? null
            : {
                id: actor.machine.id,
                cwd: actor.machine.cwd,
                env: await host.envOf(actor.id),
              };
      }
      try {
        const child = await host.create({
          agent: agent.id,
          ...(made.modelId === undefined ? {} : { modelId: made.modelId }),
          ...(made.reasoning === undefined ? {} : { reasoning: made.reasoning }),
          ...(machine === null ? {} : { machine }),
          ...(made.configuration === undefined ? {} : { configuration: made.configuration }),
          parent: { id: actor.id, name, call: call.id },
        });
        return { content: created(child.id) };
      } catch (error) {
        // Two calls of one answer with the same name: one of them was first.
        const raced = await host.child(actor.id, name);
        if (raced !== undefined) {
          return raced.spawnedBy === call.id ? { content: created(raced.actor.id) } : taken;
        }
        if (error instanceof AgentNotFound) {
          return failed(`The agent ${subagent.agent} is not deployed, so none can be created`);
        }
        if (error instanceof InvalidConfiguration && error.issues !== undefined) {
          const issues = error.issues.map((issue) => issuesText([issue]));
          return failed(
            `${subagent.agent} could not be created: its configuration is not valid:\n${issues.join('\n')}`,
          );
        }
        if (error instanceof EngineError || error instanceof NameTaken) {
          return failed(`${subagent.agent} could not be created: ${error.message}`);
        }
        throw error;
      }
    },
  };

  const message: OwnTool = {
    tool: {
      type: 'function',
      name: 'message_agent',
      description: 'Sends a message to another agent.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Who it is for.' },
          message: { type: 'string', description: 'What to say.' },
        },
        required: ['to', 'message'],
      },
    },
    // An actor with someone to talk to: one that can have subagents, or that is one.
    available: (actor, definition) => actor.parent !== null || subagentsOf(definition).length > 0,

    describe(actor, definition) {
      const above = actor.parent !== null;
      const below = subagentsOf(definition).length > 0;
      const who = [
        ...(below ? ['one of your subagents, by the name you gave it'] : []),
        ...(above ? [`\`${PARENT}\`, the agent that created you`] : []),
      ].join(', or ');
      return `Sends a message to ${who}. It is sent, and you are not answered here: when the other has something to say, a message arrives for you, marked with who it is from. A message that reaches an agent at work joins what it is doing; one that reaches an idle agent sets it to work.`;
    },

    async run(actor, _definition, args, call) {
      const { to, message: said, ...rest } = args;
      const unknown = Object.keys(rest)[0];
      if (unknown !== undefined) return failed(`${unknown} is not known`);
      if (typeof said !== 'string' || said.trim() === '') {
        return failed('message is what to say, and is not empty');
      }
      if (typeof to !== 'string' || to === '') return failed('to is who the message is for');
      // Named by the call, so that the call made again does not say it twice.
      const id = `agent:${actor.id}:${call.id}`;

      if (to === PARENT) {
        if (actor.parent === null) return failed('You have no parent: no agent created you');
        const up: SystemMessage = {
          role: 'system',
          content: [{ type: 'text', text: wrapMessage(actor.parent.name, said) }],
          metadata: { agent: { from: actor.id, name: actor.parent.name } },
        };
        try {
          await host.post(actor.parent.id, { id, message: up });
        } catch (error) {
          if (error instanceof ActorArchived) {
            return failed('Your parent is archived: it takes nothing until it is unarchived');
          }
          // Deleted: an answer, not a failure of the turn, which a restart would make again.
          if (error instanceof ActorNotFound) {
            return failed('Your parent is gone: it was deleted, and takes nothing');
          }
          throw error;
        }
        return { content: `Sent to ${PARENT}.` };
      }

      const child = await host.child(actor.id, to);
      if (child === undefined) {
        const names = (await host.children(actor.id)).map((one) => one.parent?.name ?? '');
        return failed(
          `You have no subagent ${to}. ${
            names.length === 0
              ? 'You have none: create one with spawn_agent.'
              : `You have: ${names.join(', ')}`
          }`,
        );
      }
      const down: UserMessage = {
        role: 'user',
        content: [{ type: 'text', text: wrapMessage(PARENT, said) }],
        metadata: { agent: { from: actor.id, name: PARENT } },
      };
      try {
        await host.post(child.actor.id, { id, message: down });
      } catch (error) {
        if (error instanceof ActorArchived) {
          return failed(`${to} is archived: it takes nothing until it is unarchived`);
        }
        throw error;
      }
      return { content: `Sent to ${to}.` };
    },
  };

  return [spawn, message];
}
