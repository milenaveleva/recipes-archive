import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  utf8ToBase64,
  bytesToBase64,
  verifyAccess,
  getFileSha,
  commitTextFile,
  deleteFile,
} from './github';

const repo = { owner: 'milenaveleva', repo: 'recipes-archive', branch: 'main' };

function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

let calls: { url: string; init?: RequestInit }[];
let queue: Response[];

beforeEach(() => {
  calls = [];
  queue = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const r = queue.shift();
      if (!r) throw new Error('no mock response queued');
      return r;
    }),
  );
});

function bodyOf(call: { init?: RequestInit }): Record<string, unknown> {
  return JSON.parse(String(call.init?.body));
}

function decodeContent(b64: string): string {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

describe('base64 helpers', () => {
  it('encodes UTF-8 text without mangling multi-byte chars', () => {
    expect(utf8ToBase64('café')).toBe('Y2Fmw6k=');
  });
  it('encodes raw bytes', () => {
    expect(bytesToBase64(new Uint8Array([72, 105]))).toBe('SGk=');
  });
});

describe('verifyAccess', () => {
  it('returns the default branch and push permission', async () => {
    queue = [res(200, { default_branch: 'main', permissions: { push: true } })];
    await expect(verifyAccess('tok', repo)).resolves.toEqual({
      defaultBranch: 'main',
      canPush: true,
    });
    expect(calls[0].url).toContain('/repos/milenaveleva/recipes-archive');
  });
  it('throws a descriptive error on a bad token', async () => {
    queue = [res(401, { message: 'Bad credentials' })];
    await expect(verifyAccess('tok', repo)).rejects.toThrow(
      /authentication failed \(401\) — Bad credentials/,
    );
  });
});

describe('getFileSha', () => {
  it('returns null when the file does not exist', async () => {
    queue = [res(404, {})];
    await expect(getFileSha('tok', repo, 'a/b.md')).resolves.toBeNull();
  });
  it('returns the sha and queries the branch ref', async () => {
    queue = [res(200, { sha: 'abc123' })];
    await expect(getFileSha('tok', repo, 'a/b.md')).resolves.toBe('abc123');
    expect(calls[0].url).toContain('ref=main');
  });
});

describe('commitTextFile', () => {
  it('creates a new file (no sha sent) with UTF-8 base64 content', async () => {
    queue = [
      res(404, {}), // getFileSha → not found → create
      res(201, { content: { sha: 'newsha', html_url: 'http://x/y' }, commit: { sha: 'csha' } }),
    ];
    const result = await commitTextFile('tok', repo, {
      path: 'src/content/recipes/x.md',
      content: '# Hi café',
      message: 'add x',
    });
    expect(result).toEqual({
      path: 'src/content/recipes/x.md',
      sha: 'newsha',
      commitSha: 'csha',
      updated: false,
      htmlUrl: 'http://x/y',
    });
    expect(calls[1].init?.method).toBe('PUT');
    const sent = bodyOf(calls[1]);
    expect(sent.message).toBe('add x');
    expect(sent.branch).toBe('main');
    expect('sha' in sent).toBe(false);
    expect(decodeContent(sent.content as string)).toBe('# Hi café');
  });

  it('updates an existing file by sending its current sha', async () => {
    queue = [
      res(200, { sha: 'oldsha' }), // file exists → update
      res(200, { content: { sha: 'newsha' }, commit: { sha: 'csha' } }),
    ];
    const result = await commitTextFile('tok', repo, { path: 'a.md', content: 'x', message: 'm' });
    expect(bodyOf(calls[1]).sha).toBe('oldsha');
    expect(result.updated).toBe(true);
  });

  it('surfaces the GitHub error message on failure', async () => {
    queue = [res(404, {}), res(422, { message: 'Invalid request' })];
    await expect(
      commitTextFile('tok', repo, { path: 'a.md', content: 'x', message: 'm' }),
    ).rejects.toThrow(/commit failed \(422\) — Invalid request/);
  });
});

describe('deleteFile', () => {
  it('resolves the current sha then sends a DELETE with it', async () => {
    queue = [
      res(200, { sha: 'oldsha' }), // getFileSha
      res(200, { commit: { sha: 'delsha' } }),
    ];
    const result = await deleteFile('tok', repo, {
      path: 'src/content/recipes/x.md',
      message: 'delete x',
    });
    expect(result).toEqual({ path: 'src/content/recipes/x.md', commitSha: 'delsha' });
    expect(calls[1].init?.method).toBe('DELETE');
    // The DELETE hits the encoded contents path; branch goes in the body, never as ?ref=.
    expect(calls[1].url).toContain('/contents/src/content/recipes/x.md');
    expect(calls[1].url).not.toContain('ref=');
    const sent = bodyOf(calls[1]);
    expect(sent.message).toBe('delete x');
    expect(sent.sha).toBe('oldsha');
    expect(sent.branch).toBe('main');
  });

  it('throws a 404 GitHubError when the file is already gone', async () => {
    queue = [res(404, {})]; // getFileSha → null, no DELETE attempted
    await expect(
      deleteFile('tok', repo, { path: 'a.md', message: 'm' }),
    ).rejects.toThrow(/delete failed \(404\) — a\.md not found/);
    expect(calls).toHaveLength(1); // never issued the DELETE
  });

  it('surfaces a GitHub error from the DELETE call', async () => {
    queue = [res(200, { sha: 'oldsha' }), res(409, { message: 'Conflict' })];
    await expect(
      deleteFile('tok', repo, { path: 'a.md', message: 'm' }),
    ).rejects.toThrow(/delete failed \(409\) — Conflict/);
  });
});
