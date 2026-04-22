import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { CheckpointRecord, CheckpointState } from './types';

const VERSION = 1 as const;

function empty(): CheckpointState {
  return {
    version: VERSION,
    checkpoints: [],
  };
}

export function resolveCheckpointFile(dir: string): string {
  return path.join(dir, '.opencode', 'oh-my-opencode-slim', 'checkpoints.json');
}

async function ensureParent(file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
}

export async function loadCheckpointState(
  dir: string,
): Promise<CheckpointState> {
  const file = resolveCheckpointFile(dir);

  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CheckpointState>;
    if (parsed.version !== VERSION || !Array.isArray(parsed.checkpoints)) {
      return empty();
    }
    return {
      version: VERSION,
      checkpoints: parsed.checkpoints,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return empty();
    }
    throw err;
  }
}

export async function saveCheckpointState(
  dir: string,
  state: CheckpointState,
): Promise<void> {
  const file = resolveCheckpointFile(dir);
  await ensureParent(file);
  await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export async function appendCheckpoint(
  dir: string,
  record: CheckpointRecord,
): Promise<void> {
  const state = await loadCheckpointState(dir);
  state.checkpoints.push(record);
  await saveCheckpointState(dir, state);
}

export async function replaceCheckpoint(
  dir: string,
  record: CheckpointRecord,
): Promise<void> {
  const state = await loadCheckpointState(dir);
  state.checkpoints = state.checkpoints.map((item) =>
    item.id === record.id ? record : item,
  );
  await saveCheckpointState(dir, state);
}

export async function deleteCheckpoint(
  dir: string,
  id: string,
): Promise<boolean> {
  const state = await loadCheckpointState(dir);
  const next = state.checkpoints.filter((item) => item.id !== id);
  if (next.length === state.checkpoints.length) {
    return false;
  }
  state.checkpoints = next;
  await saveCheckpointState(dir, state);
  return true;
}
