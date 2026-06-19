/**
 * Minimal GitHub Contents API client for committing recipe markdown (and
 * images) to the repo straight from the browser during in-app authoring.
 *
 * Single-user by design: the caller supplies a fine-grained personal access
 * token (contents:write on this one repo), stored client-side. Isomorphic —
 * uses `fetch` + `btoa` + `TextEncoder`, available in the browser, Cloudflare
 * Workers, and Node 18+ — so it is unit-testable with a mocked fetch.
 */

export interface GitHubRepo {
  owner: string;
  repo: string;
  /** Target branch; omitted → the repo's default branch. */
  branch?: string;
}

export interface CommitResult {
  path: string;
  /** New blob sha of the committed file. */
  sha: string;
  /** Sha of the commit that wrote it. */
  commitSha: string;
  /** True when an existing file was overwritten rather than created. */
  updated: boolean;
  htmlUrl?: string;
}

const API = 'https://api.github.com';

/** A failed GitHub API call, carrying the HTTP status so callers branch on data, not message text. */
export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function contentsUrl(repo: GitHubRepo, path: string): string {
  // Encode each segment but keep the slashes that delimit the repo path.
  const clean = path
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  return `${API}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/contents/${clean}`;
}

/** UTF-8-safe base64 (plain btoa mangles multi-byte characters). */
export function utf8ToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

/** Base64-encode raw bytes (e.g. a fetched image). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function fail(res: Response, action: string): Promise<never> {
  let detail = '';
  try {
    const body = (await res.json()) as { message?: string };
    if (body?.message) detail = ` — ${body.message}`;
  } catch {
    // No JSON body; the status code is enough.
  }
  throw new GitHubError(`GitHub ${action} failed (${res.status})${detail}`, res.status);
}

/**
 * Verify a token + repo and report the default branch and push permission, so
 * the UI can fail fast with a clear message before the user does any work.
 */
export async function verifyAccess(
  token: string,
  repo: GitHubRepo,
): Promise<{ defaultBranch: string; canPush: boolean }> {
  const res = await fetch(`${API}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`, {
    headers: headers(token),
  });
  if (!res.ok) return fail(res, 'authentication');
  const body = (await res.json()) as {
    default_branch?: string;
    permissions?: { push?: boolean };
  };
  return { defaultBranch: body.default_branch ?? 'main', canPush: body.permissions?.push === true };
}

/**
 * The sha of an existing file (required to UPDATE it), or null when the file
 * does not yet exist (CREATE).
 */
export async function getFileSha(
  token: string,
  repo: GitHubRepo,
  path: string,
): Promise<string | null> {
  const url = new URL(contentsUrl(repo, path));
  if (repo.branch) url.searchParams.set('ref', repo.branch);
  const res = await fetch(url.toString(), { headers: headers(token) });
  if (res.status === 404) return null;
  if (!res.ok) return fail(res, 'read');
  const body = (await res.json()) as { sha?: string };
  return body.sha ?? null;
}

/** Create or update a file given its already-base64-encoded content. */
async function putContents(
  token: string,
  repo: GitHubRepo,
  path: string,
  message: string,
  contentBase64: string,
): Promise<CommitResult> {
  const sha = await getFileSha(token, repo, path);
  const body: Record<string, unknown> = { message, content: contentBase64 };
  if (repo.branch) body.branch = repo.branch;
  if (sha) body.sha = sha; // update in place rather than failing on conflict
  const res = await fetch(contentsUrl(repo, path), {
    method: 'PUT',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return fail(res, 'commit');
  const out = (await res.json()) as {
    content?: { sha?: string; html_url?: string };
    commit?: { sha?: string };
  };
  return {
    path,
    sha: out.content?.sha ?? '',
    commitSha: out.commit?.sha ?? '',
    updated: sha != null,
    htmlUrl: out.content?.html_url,
  };
}

/** Commit a UTF-8 text file (e.g. recipe markdown). */
export function commitTextFile(
  token: string,
  repo: GitHubRepo,
  input: { path: string; content: string; message: string },
): Promise<CommitResult> {
  return putContents(token, repo, input.path, input.message, utf8ToBase64(input.content));
}

/** Commit a binary file (e.g. a fetched hero image). */
export function commitBinaryFile(
  token: string,
  repo: GitHubRepo,
  input: { path: string; bytes: Uint8Array; message: string },
): Promise<CommitResult> {
  return putContents(token, repo, input.path, input.message, bytesToBase64(input.bytes));
}
