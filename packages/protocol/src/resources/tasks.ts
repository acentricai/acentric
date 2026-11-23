// Tasks: work an actor's model started that may go on after the call that started it, such as
// a command on a machine.
//
// A task is attached while the call that started it still waits for it, and its ending is then
// that call's result. It detaches when the call asks for that, when its wait runs out, or when
// a person's message arrives. A detached task goes on, and its ending reaches the model as a
// notice: an input of the type `notice`, which wakes the actor.

import { z } from 'zod';

import { jsonSchema } from '../json.ts';
import { timestampSchema } from '../primitives.ts';
import { actorSchema } from './actors.ts';

/**
 * A task's ID among its actor's: a letter or a few for its kind, and its number among the
 * actor's tasks of that kind, such as `b3`. It is what the model is told, and names to stop it.
 */
export const taskIdSchema = z
  .string()
  .regex(/^[a-z]{1,8}[1-9][0-9]{0,8}$/, 'A task is named by its kind and its number, such as b3')
  .meta({ description: "A task's ID among its actor's.", examples: ['b3'] });

/**
 * `done` whatever the work's own outcome was, `failed` when it could not be done at all,
 * `stopped` when something ended it, `lost` when what ran it is gone.
 */
export const TASK_STATUSES = ['running', 'done', 'failed', 'stopped', 'lost'] as const;
export const taskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/** What stopped a task: its timeout, the model, a person, or an abort of its actor. */
export const taskStoppedBySchema = z.enum(['timeout', 'model', 'person', 'abort']);
export type TaskStoppedBy = z.infer<typeof taskStoppedBySchema>;

export const taskSchema = z
  .object({
    id: taskIdSchema,
    /** What kind of work it is, such as `bash`. */
    kind: z.string().min(1),
    status: taskStatusSchema,
    /** For one that was stopped. */
    stoppedBy: taskStoppedBySchema.optional(),
    /** Whether the call that started it still waits for it. */
    attached: z.boolean(),
    startedAt: timestampSchema,
    endedAt: timestampSchema.optional(),
  })
  .meta({ id: 'Task' });
export type Task = z.infer<typeof taskSchema>;

/** A task with what it was started with, and all it came to. */
export const taskDetailSchema = taskSchema
  .extend({
    input: jsonSchema,
    /** Null while it runs. */
    result: z.string().nullable(),
  })
  .meta({ id: 'TaskDetail' });
export type TaskDetail = z.infer<typeof taskDetailSchema>;

export const listTasksQuerySchema = z.object({
  /** Only those under way. */
  running: z.stringbool().optional(),
});

/** An actor that was aborted, and the tasks that were stopped with its turn. */
export const abortResponseSchema = z
  .object({
    actor: actorSchema,
    /** Whether it was in a turn, which was ended. */
    interrupted: z.boolean(),
    tasks: z.array(taskSchema),
    /** Its subagents that were stopped with it, by the names it gave them. */
    agents: z.array(z.string()),
  })
  .meta({ id: 'AbortResponse' });
export type AbortResponse = z.infer<typeof abortResponseSchema>;
