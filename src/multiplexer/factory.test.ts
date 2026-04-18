import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { clearMultiplexerCache, getMultiplexer } from './factory';

describe('multiplexer factory', () => {
  const originalTmux = process.env.TMUX;
  const originalTmuxPane = process.env.TMUX_PANE;

  beforeEach(() => {
    clearMultiplexerCache();
  });

  afterEach(() => {
    process.env.TMUX = originalTmux;
    process.env.TMUX_PANE = originalTmuxPane;
    clearMultiplexerCache();
  });

  test('returns a fresh tmux instance per call', () => {
    process.env.TMUX = '/tmp/tmux-1000/default,123,0';
    process.env.TMUX_PANE = '%1';

    const first = getMultiplexer({
      type: 'tmux',
      layout: 'main-vertical',
      main_pane_size: 60,
    });
    process.env.TMUX_PANE = '%2';
    const second = getMultiplexer({
      type: 'tmux',
      layout: 'main-vertical',
      main_pane_size: 60,
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(Object.is(first, second)).toBe(false);
  });

  test('returns a fresh auto-detected tmux instance per call', () => {
    process.env.TMUX = '/tmp/tmux-1000/default,123,0';
    process.env.TMUX_PANE = '%1';

    const first = getMultiplexer({
      type: 'auto',
      layout: 'main-vertical',
      main_pane_size: 60,
    });
    process.env.TMUX_PANE = '%2';
    const second = getMultiplexer({
      type: 'auto',
      layout: 'main-vertical',
      main_pane_size: 60,
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(Object.is(first, second)).toBe(false);
  });
});
