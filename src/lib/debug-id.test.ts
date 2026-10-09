import { describe, expect, it } from 'vitest';
import { computeDebugId, DEBUG_ID_PATTERN } from './debug-id';

const V4_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('computeDebugId', () => {
  it('formats the first 16 bytes of the SHA-256 as a v4 UUID with the RFC variant', () => {
    for (const content of ['', 'console.log(1);\n', 'x'.repeat(10_000), 'é中']) {
      const id = computeDebugId(Buffer.from(content));
      expect(id).toMatch(V4_UUID);
      expect(id).toMatch(DEBUG_ID_PATTERN);
    }
  });

  it('keeps the hash bits outside the version and variant positions', () => {
    // sha256('') = e3b0c442 98fc 1c14 9afb f4c8 996f b924 27ae41e4...
    expect(computeDebugId(Buffer.from(''))).toBe('e3b0c442-98fc-4c14-9afb-f4c8996fb924');
  });

  it('is stable for the same content and differs for different content', () => {
    const first = computeDebugId(Buffer.from('function a(){}'));
    expect(computeDebugId(Buffer.from('function a(){}'))).toBe(first);
    expect(computeDebugId(Buffer.from('function b(){}'))).not.toBe(first);
  });
});
