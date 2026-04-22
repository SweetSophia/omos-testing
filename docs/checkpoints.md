# Checkpoints

Checkpoints add named rollback milestones on top of OpenCode's built-in
session revert and snapshot system.

## What they do

- create a visible checkpoint anchor in the current root orchestrator session
- save a human-readable label like `before multiplexer refactor`
- let you list, inspect, restore, or delete saved checkpoints later
- let the orchestrator use the same feature through the `checkpoint` tool

Restores use upstream OpenCode session revert, so file changes and session state
rewind together.

## Commands

```text
/checkpoint create "before multiplexer refactor"
/checkpoint list
/checkpoint show cp-8f92a
/checkpoint restore cp-8f92a
/checkpoint drop cp-8f92a
```

If you run `/checkpoint` with a bare label, it is treated like `create`.

## Workflow

Good times to create checkpoints:

- before risky multi-file edits
- before parallel delegation
- after a major milestone worth preserving

Avoid creating them for tiny one-file tweaks or read-only work.

## Visibility

Checkpoint creation posts a visible status message into the session so you can
see when checkpoints were created.

Use `/checkpoint list` to see the current timeline for the active root session.

## Limits

- checkpoints are root-session only in the current MVP
- restore is blocked while child sessions are still active
- checkpoint metadata is stored in `.opencode/oh-my-opencode-slim/checkpoints.json`
