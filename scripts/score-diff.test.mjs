import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./score-diff.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

describe('score-diff exit code', () => {
  it('exits 1 when the report cannot be produced', () => {
    const badRef = run('--ref', 'no-such-ref-xyz');
    expect(badRef.status).toBe(1);
    expect(badRef.stderr).toContain('score-diff failed');
    expect(run('--bogus').status).toBe(1);
    expect(run('--threshold', '-3').status).toBe(1);
  });

  it('exits 0 for --help', () => {
    expect(run('--help').status).toBe(0);
  });
});
