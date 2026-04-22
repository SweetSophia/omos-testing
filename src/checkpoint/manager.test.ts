import { describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { createCheckpointManager } from './manager';

function createMockContext(overrides?: {
  directory?: string;
  promptImpl?: (args: unknown) => Promise<unknown>;
  revertImpl?: (args: unknown) => Promise<unknown>;
}) {
  return {
    client: {
      session: {
        prompt: mock(async (args: unknown) => {
          if (overrides?.promptImpl) {
            return overrides.promptImpl(args);
          }
          return { data: { info: { id: 'msg-checkpoint' } } };
        }),
        revert: mock(async (args: unknown) => {
          if (overrides?.revertImpl) {
            return overrides.revertImpl(args);
          }
          return {};
        }),
      },
    },
    directory: overrides?.directory ?? '/tmp/checkpoint-test',
  } as any;
}

function createDepth(getDepth = 0) {
  return {
    getDepth: mock((_sessionID: string) => getDepth),
  } as any;
}

function toolCtx(sessionID: string) {
  return {
    sessionID,
    messageID: 'msg-ctx',
    directory: '/tmp',
    worktree: '/tmp',
    abort: new AbortController().signal,
    ask: mock(async () => ({})),
    read: mock(async () => ''),
    agent: 'orchestrator',
  } as any;
}

describe('checkpoint manager', () => {
  test('registers checkpoint command', () => {
    const ctx = createMockContext();
    const manager = createCheckpointManager(ctx, createDepth());
    const cfg: Record<string, unknown> = {};

    manager.registerCommand(cfg);

    expect(cfg.command).toBeTruthy();
    expect((cfg.command as Record<string, unknown>).checkpoint).toBeTruthy();
  });

  test('create command stores checkpoint and posts anchor notification', async () => {
    const dir = await fs.mkdtemp('/tmp/checkpoint-test-');
    const ctx = createMockContext({ directory: dir });
    const manager = createCheckpointManager(ctx, createDepth());
    const output = { parts: [] as Array<{ type: string; text?: string }> };

    await manager.handleCommandExecuteBefore(
      {
        command: 'checkpoint',
        sessionID: 'root-1',
        arguments: 'create "before refactor"',
      },
      output,
    );

    expect(output.parts).toHaveLength(0);
    expect(ctx.client.session.prompt).toHaveBeenCalled();
    const call = ctx.client.session.prompt.mock.calls[0]?.[0] as {
      body?: { noReply?: boolean; parts?: Array<{ text?: string }> };
    };
    expect(call.body?.noReply).toBe(true);
    expect(call.body?.parts?.[0]?.text).toContain(
      'Checkpoint saved: before refactor',
    );

    const raw = await fs.readFile(
      `${dir}/.opencode/oh-my-opencode-slim/checkpoints.json`,
      'utf8',
    );
    expect(raw).toContain('before refactor');
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('list command shows saved checkpoints for current root session', async () => {
    const dir = await fs.mkdtemp('/tmp/checkpoint-test-');
    const ctx = createMockContext({ directory: dir });
    const manager = createCheckpointManager(ctx, createDepth());
    await manager.tool.checkpoint.execute(
      { action: 'create', label: 'before alpha' },
      toolCtx('root-1'),
    );

    const output = { parts: [] as Array<{ type: string; text?: string }> };
    await manager.handleCommandExecuteBefore(
      {
        command: 'checkpoint',
        sessionID: 'root-1',
        arguments: 'list',
      },
      output,
    );

    expect(output.parts[0]?.text).toContain('Checkpoint timeline');
    expect(output.parts[0]?.text).toContain('before alpha');
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('restore command calls upstream session.revert', async () => {
    const dir = await fs.mkdtemp('/tmp/checkpoint-test-');
    const ctx = createMockContext({ directory: dir });
    const manager = createCheckpointManager(ctx, createDepth());
    await manager.tool.checkpoint.execute(
      { action: 'create', label: 'before beta' },
      toolCtx('root-1'),
    );

    const output = { parts: [] as Array<{ type: string; text?: string }> };
    await manager.handleCommandExecuteBefore(
      {
        command: 'checkpoint',
        sessionID: 'root-1',
        arguments: 'restore before beta',
      },
      output,
    );

    expect(ctx.client.session.revert).toHaveBeenCalled();
    const call = ctx.client.session.revert.mock.calls[0]?.[0] as {
      path?: { id?: string };
      body?: { messageID?: string };
    };
    expect(call.path?.id).toBe('root-1');
    expect(call.body?.messageID).toBe('msg-checkpoint');
    expect(output.parts[0]?.text).toContain(
      'Reverted via OpenCode session revert',
    );
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('restore is blocked while child session is active', async () => {
    const dir = await fs.mkdtemp('/tmp/checkpoint-test-');
    const ctx = createMockContext({ directory: dir });
    const manager = createCheckpointManager(ctx, createDepth());
    await manager.tool.checkpoint.execute(
      { action: 'create', label: 'before gamma' },
      toolCtx('root-1'),
    );

    await manager.handleEvent({
      event: {
        type: 'session.created',
        properties: {
          info: { id: 'child-1', parentID: 'root-1' },
        },
      },
    });

    const output = { parts: [] as Array<{ type: string; text?: string }> };
    await manager.handleCommandExecuteBefore(
      {
        command: 'checkpoint',
        sessionID: 'root-1',
        arguments: 'restore before gamma',
      },
      output,
    );

    expect(ctx.client.session.revert).not.toHaveBeenCalled();
    expect(output.parts[0]?.text).toContain(
      'Cannot restore while child sessions are still active',
    );
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('idle child sessions still block restore until deletion', async () => {
    const dir = await fs.mkdtemp('/tmp/checkpoint-test-');
    const ctx = createMockContext({ directory: dir });
    const manager = createCheckpointManager(ctx, createDepth());
    await manager.tool.checkpoint.execute(
      { action: 'create', label: 'before delta' },
      toolCtx('root-1'),
    );

    await manager.handleEvent({
      event: {
        type: 'session.created',
        properties: {
          info: { id: 'child-1', parentID: 'root-1' },
        },
      },
    });
    await manager.handleEvent({
      event: {
        type: 'session.status',
        properties: {
          sessionID: 'child-1',
          status: { type: 'idle' },
        },
      },
    });

    const output = { parts: [] as Array<{ type: string; text?: string }> };
    await manager.handleCommandExecuteBefore(
      {
        command: 'checkpoint',
        sessionID: 'root-1',
        arguments: 'restore before delta',
      },
      output,
    );

    expect(ctx.client.session.revert).not.toHaveBeenCalled();
    expect(output.parts[0]?.text).toContain(
      'Cannot restore while child sessions are still active',
    );
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('list marks the most recently restored checkpoint as current', async () => {
    const dir = await fs.mkdtemp('/tmp/checkpoint-test-');
    const ctx = createMockContext({ directory: dir });
    const manager = createCheckpointManager(ctx, createDepth());
    await manager.tool.checkpoint.execute(
      { action: 'create', label: 'before one' },
      toolCtx('root-1'),
    );
    await manager.tool.checkpoint.execute(
      { action: 'create', label: 'before two' },
      toolCtx('root-1'),
    );
    await manager.handleCommandExecuteBefore(
      {
        command: 'checkpoint',
        sessionID: 'root-1',
        arguments: 'restore before one',
      },
      { parts: [] },
    );

    const output = { parts: [] as Array<{ type: string; text?: string }> };
    await manager.handleCommandExecuteBefore(
      {
        command: 'checkpoint',
        sessionID: 'root-1',
        arguments: 'list',
      },
      output,
    );

    expect(output.parts[0]?.text).toContain('before one      [current]');
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('subagent sessions are rejected', async () => {
    const dir = await fs.mkdtemp('/tmp/checkpoint-test-');
    const ctx = createMockContext({ directory: dir });
    const manager = createCheckpointManager(ctx, createDepth(1));
    const output = { parts: [] as Array<{ type: string; text?: string }> };

    await manager.handleCommandExecuteBefore(
      {
        command: 'checkpoint',
        sessionID: 'child-1',
        arguments: 'create nope',
      },
      output,
    );

    expect(output.parts[0]?.text).toContain('root orchestrator session');
    expect(ctx.client.session.prompt).not.toHaveBeenCalled();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
