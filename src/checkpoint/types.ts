export type CheckpointSource = 'manual' | 'auto';

export interface CheckpointRecord {
  id: string;
  label: string;
  createdAt: string;
  source: CheckpointSource;
  reason?: string;
  sessionID: string;
  rootSessionID: string;
  messageID: string;
  partID?: string;
  restoredAt?: string;
}

export interface CheckpointState {
  version: 1;
  checkpoints: CheckpointRecord[];
}

export interface SessionMessagePart {
  id?: string;
  type?: string;
  text?: string;
}

export interface SessionMessage {
  info?: {
    id?: string;
    role?: string;
  };
  parts?: SessionMessagePart[];
}
