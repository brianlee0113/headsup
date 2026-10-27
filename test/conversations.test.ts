import { describe, expect, it } from 'vitest';
import { runConversations } from '../sim/conversations.js';

describe('conversations, turn by turn', () => {
  it('does what each turn expects', () => {
    const r = runConversations();
    expect(r.failures).toEqual([]);
    expect(r.turns).toBeGreaterThan(20);
  });
});
