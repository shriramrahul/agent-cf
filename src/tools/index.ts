import type { Env } from '../types/client';
import { listToday, mutateTasks, type TaskOperation, type TaskSlot } from '../db/tasks';
import { executeJs } from './js-engine';

export type ToolDef = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

/** OpenAI-compatible function schemas, passed straight to the LLM. */
export const toolDefs: ToolDef[] = [
  {
    name: 'execute_js',
    description: 'Run sandboxed JavaScript and return its output plus console logs.',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: 'Async function body to execute' } },
      required: ['code'],
    },
  },
  {
    name: 'task_mutate',
    description: 'Create, update, complete, or reschedule tasks in D1.',
    parameters: {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['CREATE', 'UPDATE', 'COMPLETE', 'RESCHEDULE'] },
              id: { type: 'string' },
              title: { type: 'string' },
              type: { type: 'string', enum: ['area', 'goal', 'project', 'task', 'subtask'] },
              parent_id: { type: 'string', description: 'Parent task id for hierarchy' },
              slot: { type: 'string', enum: ['now', 'next', 'later', 'future'] },
              status: { type: 'string' },
              context: { type: 'string' },
              scheduled_date: { type: 'string', description: 'YYYY-MM-DD, omit for inbox' },
              reason: { type: 'string', description: 'Why (reschedule, pause, cancel, ...)' },
            },
            required: ['op'],
          },
        },
      },
      required: ['operations'],
    },
  },
  {
    name: 'get_today_plan',
    description: 'Return today\'s NOW/NEXT/LATER breakdown (dated today, not completed).',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'set_reminder',
    description: 'Schedule a reminder as a dated task for cron dispatch.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        scheduled_date: { type: 'string', description: 'YYYY-MM-DD' },
        slot: { type: 'string', enum: ['now', 'next', 'later', 'future'] },
      },
      required: ['title', 'scheduled_date'],
    },
  },
];

/** Dispatches one LLM-requested tool call. Cron dispatch lands in Task 5. */
export async function runTool(name: string, args: Record<string, unknown>, env: Env): Promise<unknown> {
  switch (name) {
    case 'execute_js':
      return executeJs(args.code as string);
    case 'task_mutate':
      return mutateTasks(env, args.operations as TaskOperation[]);
    case 'get_today_plan':
      return listToday(env);
    case 'set_reminder':
      return mutateTasks(env, [
        {
          op: 'CREATE',
          title: args.title as string,
          scheduled_date: args.scheduled_date as string,
          slot: (args.slot as TaskSlot | undefined) ?? 'next',
        },
      ]);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
