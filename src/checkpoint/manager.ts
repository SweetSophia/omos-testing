import type { PluginInput, ToolDefinition } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin/tool';
import { log } from '../utils';
import type { SubagentDepthTracker } from '../utils/subagent-depth';
import {
  appendCheckpoint,
  deleteCheckpoint,
  loadCheckpointState,
  replaceCheckpoint,
} from './store';
import type { CheckpointRecord, CheckpointSource } from './types';

const COMMAND_NAME = 'checkpoint';
const NO_ACTION_NEEDED_TEXT = '[system status: no action needed]';
const z = tool.schema;

function stripQuotes(text: string): string {
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1).trim();
  }
  return text.trim();
}

function makeId(): string {
  return `cp-${Math.random().toString(36).slice(2, 7)}`;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function fmtCheckpoint(item: CheckpointRecord, current = false): string {
  const mark = current ? '      [current]' : '';
  return [
    `• ${item.id}  ${item.label}${mark}`,
    `  ${item.source} • ${fmtTime(item.createdAt)}`,
  ].join('\n');
}

function currentId(items: CheckpointRecord[]): string | null {
  const restored = items
    .filter((item) => item.restoredAt)
    .sort(
      (a, b) =>
        new Date(b.restoredAt ?? '').getTime() -
        new Date(a.restoredAt ?? '').getTime(),
    )[0];

  if (restored) {
    return restored.id;
  }

  return items[0]?.id ?? null;
}

function usage(): string {
  return [
    'Checkpoint commands:',
    '/checkpoint create <label>',
    '/checkpoint list',
    '/checkpoint show <id|label>',
    '/checkpoint restore <id|label>',
    '/checkpoint drop <id|label>',
  ].join('\n');
}

function parseArgs(
  raw: string,
):
  | { action: 'create' | 'list' | 'show' | 'restore' | 'drop'; value?: string }
  | { action: 'help' } {
  const text = raw.trim();
  if (!text) {
    return { action: 'help' };
  }

  const [head, ...rest] = text.split(/\s+/);
  if (head === 'list') {
    return { action: 'list' };
  }
  if (
    head === 'create' ||
    head === 'show' ||
    head === 'restore' ||
    head === 'drop'
  ) {
    return {
      action: head,
      value: stripQuotes(rest.join(' ')),
    };
  }
  return {
    action: 'create',
    value: stripQuotes(text),
  };
}

function isRoot(depth: SubagentDepthTracker, sessionID: string): boolean {
  return depth.getDepth(sessionID) === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function promptMessageId(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const direct = value.info;
  if (isRecord(direct) && typeof direct.id === 'string') {
    return direct.id;
  }
  const data = value.data;
  if (!isRecord(data)) {
    return undefined;
  }
  const info = data.info;
  if (isRecord(info) && typeof info.id === 'string') {
    return info.id;
  }
  return undefined;
}

export function createCheckpointManager(
  ctx: PluginInput,
  depth: SubagentDepthTracker,
): {
  tool: { checkpoint: ToolDefinition };
  registerCommand: (config: Record<string, unknown>) => void;
  handleCommandExecuteBefore: (
    input: { command: string; sessionID: string; arguments: string },
    output: { parts: Array<{ type: string; text?: string }> },
  ) => Promise<void>;
  handleEvent: (input: {
    event: { type: string; properties?: Record<string, unknown> };
  }) => Promise<void>;
} {
  const childByParent = new Map<string, Set<string>>();
  const parentByChild = new Map<string, string>();

  function activeChildren(root: string): string[] {
    return [...(childByParent.get(root) ?? new Set())];
  }

  function ensureRootSession(sessionID: string): void {
    if (!isRoot(depth, sessionID)) {
      throw new Error(
        'Checkpoints are only available from the root orchestrator session.',
      );
    }
  }

  async function list(rootSessionID: string): Promise<CheckpointRecord[]> {
    const state = await loadCheckpointState(ctx.directory);
    return state.checkpoints
      .filter((item) => item.rootSessionID === rootSessionID)
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
  }

  async function resolve(
    rootSessionID: string,
    ref: string,
  ): Promise<CheckpointRecord | null> {
    const items = await list(rootSessionID);
    return items.find((item) => item.id === ref || item.label === ref) ?? null;
  }

  async function anchor(
    sessionID: string,
    id: string,
    label: string,
    source: CheckpointSource,
  ): Promise<string> {
    const icon = source === 'auto' ? '📸' : '📍';
    const status =
      source === 'auto' ? 'Auto-checkpoint saved' : 'Checkpoint saved';
    const result = await ctx.client.session.prompt({
      path: { id: sessionID },
      body: {
        noReply: true,
        parts: [
          {
            type: 'text',
            text: [
              `${icon} ${status}: ${label}`,
              `ID: ${id} • ${source} • ${fmtTime(new Date().toISOString())}`,
              '',
              NO_ACTION_NEEDED_TEXT,
            ].join('\n'),
          },
        ],
      },
    });
    const idValue = promptMessageId(result);
    if (!idValue) {
      throw new Error('Checkpoint anchor message was created without an id.');
    }
    return idValue;
  }

  async function create(input: {
    sessionID: string;
    label: string;
    source: CheckpointSource;
    reason?: string;
  }): Promise<CheckpointRecord> {
    ensureRootSession(input.sessionID);
    const label = stripQuotes(input.label);
    if (!label) {
      throw new Error('Checkpoint label is required.');
    }

    const id = makeId();
    const createdAt = new Date().toISOString();
    const messageID = await anchor(input.sessionID, id, label, input.source);
    const record: CheckpointRecord = {
      id,
      label,
      createdAt,
      source: input.source,
      reason: input.reason,
      sessionID: input.sessionID,
      rootSessionID: input.sessionID,
      messageID,
    };
    await appendCheckpoint(ctx.directory, record);
    return record;
  }

  async function restore(input: {
    sessionID: string;
    ref: string;
  }): Promise<CheckpointRecord> {
    ensureRootSession(input.sessionID);
    const children = activeChildren(input.sessionID);
    if (children.length > 0) {
      throw new Error(
        `Cannot restore while child sessions are still active: ${children.join(', ')}`,
      );
    }

    const item = await resolve(input.sessionID, input.ref);
    if (!item) {
      throw new Error(`Checkpoint not found: ${input.ref}`);
    }
    await ctx.client.session.revert({
      path: { id: item.sessionID },
      body: {
        messageID: item.messageID,
        ...(item.partID ? { partID: item.partID } : {}),
      },
    });
    const next = {
      ...item,
      restoredAt: new Date().toISOString(),
    };
    await replaceCheckpoint(ctx.directory, next);
    return next;
  }

  async function drop(input: {
    sessionID: string;
    ref: string;
  }): Promise<CheckpointRecord> {
    ensureRootSession(input.sessionID);
    const item = await resolve(input.sessionID, input.ref);
    if (!item) {
      throw new Error(`Checkpoint not found: ${input.ref}`);
    }
    await deleteCheckpoint(ctx.directory, item.id);
    return item;
  }

  function registerCommand(opencodeConfig: Record<string, unknown>): void {
    const configCommand = opencodeConfig.command as
      | Record<string, unknown>
      | undefined;
    if (!configCommand?.[COMMAND_NAME]) {
      if (!opencodeConfig.command) {
        opencodeConfig.command = {};
      }
      (opencodeConfig.command as Record<string, unknown>)[COMMAND_NAME] = {
        template: 'Manage named checkpoints for the current root session',
        description:
          'Create, list, show, restore, and delete named rollback checkpoints',
      };
    }
  }

  const checkpoint: ToolDefinition = tool({
    description:
      'Manage named checkpoints for the current root orchestrator session. Creates visible checkpoint anchors and restores via OpenCode session revert.',
    args: {
      action: z.enum(['create', 'list', 'show', 'restore', 'drop', 'delete']),
      id: z.string().optional(),
      label: z.string().optional(),
      reason: z.string().optional(),
    },
    async execute(args, toolContext) {
      if (
        !toolContext ||
        typeof toolContext !== 'object' ||
        !('sessionID' in toolContext)
      ) {
        throw new Error('Invalid toolContext: missing sessionID');
      }

      const sessionID = (toolContext as { sessionID: string }).sessionID;
      const agent = (toolContext as { agent?: string }).agent;
      if (agent && agent !== 'orchestrator') {
        throw new Error(
          `Checkpoint tool is only available to the orchestrator. Current agent: ${agent}`,
        );
      }

      if (args.action === 'create') {
        const record = await create({
          sessionID,
          label: args.label ?? args.reason ?? 'checkpoint',
          source: 'auto',
          reason: args.reason,
        });
        return `Checkpoint saved: ${record.label} (${record.id})`;
      }

      if (args.action === 'list') {
        const items = await list(sessionID);
        if (items.length === 0) {
          return 'No checkpoints saved for this session.';
        }
        const current = currentId(items);
        return [
          'Checkpoint timeline',
          '',
          ...items.map((item, index) =>
            fmtCheckpoint(
              item,
              item.id === current || (!current && index === 0),
            ),
          ),
        ].join('\n');
      }

      const ref = args.id ?? args.label;
      if (!ref) {
        throw new Error('Checkpoint id or label is required for this action.');
      }

      if (args.action === 'show') {
        const item = await resolve(sessionID, ref);
        if (!item) {
          throw new Error(`Checkpoint not found: ${ref}`);
        }
        return [
          `Checkpoint: ${item.label}`,
          `ID: ${item.id}`,
          `Created: ${fmtTime(item.createdAt)}`,
          `Source: ${item.source}`,
          `Session: ${item.rootSessionID}`,
          `Target: message ${item.messageID}`,
          ...(item.reason ? [`Reason: ${item.reason}`] : []),
        ].join('\n');
      }

      if (args.action === 'restore') {
        const item = await restore({ sessionID, ref });
        return `Restored checkpoint: ${item.label} (${item.id})`;
      }

      const item = await drop({ sessionID, ref });
      return `Dropped checkpoint: ${item.label} (${item.id})`;
    },
  });

  async function handleCommandExecuteBefore(
    input: { command: string; sessionID: string; arguments: string },
    output: { parts: Array<{ type: string; text?: string }> },
  ): Promise<void> {
    if (input.command !== COMMAND_NAME) {
      return;
    }

    output.parts.length = 0;

    try {
      const parsed = parseArgs(input.arguments);
      if (parsed.action === 'help') {
        output.parts.push({ type: 'text', text: usage() });
        return;
      }

      if (parsed.action === 'create') {
        await create({
          sessionID: input.sessionID,
          label: parsed.value ?? '',
          source: 'manual',
        });
        return;
      }

      if (parsed.action === 'list') {
        const items = await list(input.sessionID);
        const current = currentId(items);
        output.parts.push({
          type: 'text',
          text:
            items.length === 0
              ? 'No checkpoints saved for this session.'
              : [
                  'Checkpoint timeline',
                  '',
                  ...items.map((item, index) =>
                    fmtCheckpoint(
                      item,
                      item.id === current || (!current && index === 0),
                    ),
                  ),
                ].join('\n'),
        });
        return;
      }

      const ref = parsed.value?.trim();
      if (!ref) {
        output.parts.push({ type: 'text', text: usage() });
        return;
      }

      if (parsed.action === 'show') {
        const item = await resolve(input.sessionID, ref);
        if (!item) {
          throw new Error(`Checkpoint not found: ${ref}`);
        }
        output.parts.push({
          type: 'text',
          text: [
            `Checkpoint: ${item.label}`,
            `ID: ${item.id}`,
            `Created: ${fmtTime(item.createdAt)}`,
            `Source: ${item.source}`,
            `Session: ${item.rootSessionID}`,
            `Target: message ${item.messageID}`,
            ...(item.reason ? [`Reason: ${item.reason}`] : []),
          ].join('\n'),
        });
        return;
      }

      if (parsed.action === 'restore') {
        const item = await restore({ sessionID: input.sessionID, ref });
        output.parts.push({
          type: 'text',
          text: [
            `🔄 Restoring checkpoint: ${item.label}`,
            '✓ Reverted via OpenCode session revert',
          ].join('\n'),
        });
        return;
      }

      const item = await drop({ sessionID: input.sessionID, ref });
      output.parts.push({
        type: 'text',
        text: `Dropped checkpoint: ${item.label} (${item.id})`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('[checkpoint] command failed', {
        sessionID: input.sessionID,
        command: input.arguments,
        error: msg,
      });
      output.parts.push({
        type: 'text',
        text: `Checkpoint error: ${msg}`,
      });
    }
  }

  async function handleEvent(input: {
    event: { type: string; properties?: Record<string, unknown> };
  }): Promise<void> {
    const event = input.event;
    if (event.type === 'session.created') {
      const props = event.properties;
      const info = isRecord(props?.info) ? props?.info : undefined;
      const child = typeof info?.id === 'string' ? info.id : undefined;
      const parent =
        typeof info?.parentID === 'string' ? info.parentID : undefined;
      if (!child || !parent) {
        return;
      }
      parentByChild.set(child, parent);
      const set = childByParent.get(parent) ?? new Set<string>();
      set.add(child);
      childByParent.set(parent, set);
      return;
    }

    if (event.type !== 'session.deleted') {
      return;
    }

    const props = event.properties;
    const sessionID =
      (isRecord(props?.info) && typeof props.info.id === 'string'
        ? props.info.id
        : undefined) ??
      (typeof props?.sessionID === 'string' ? props.sessionID : undefined);
    if (!sessionID) {
      return;
    }

    const parent = parentByChild.get(sessionID);
    if (!parent) {
      return;
    }
    parentByChild.delete(sessionID);
    const set = childByParent.get(parent);
    if (!set) {
      return;
    }
    set.delete(sessionID);
    if (set.size === 0) {
      childByParent.delete(parent);
    }
  }

  return {
    tool: { checkpoint },
    registerCommand,
    handleCommandExecuteBefore,
    handleEvent,
  };
}
