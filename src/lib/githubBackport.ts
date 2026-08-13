/**
 * Minimal GitHub REST client for the firmware-backport feature: read the
 * current firmware source files and write them back as ONE atomic commit via
 * the git data API (api.github.com supports CORS, so this runs entirely in
 * the browser).
 *
 * The fine-grained PAT is kept ONLY in localStorage (never logged, never sent
 * anywhere but api.github.com); the needed scope is a single-repo token with
 * "Contents: Read and write".
 */

/** localStorage key holding the user's fine-grained PAT. */
export const GITHUB_BACKPORT_TOKEN_KEY = "githubBackportToken";

/** Firmware source repo the backport targets by default (editable in the UI). */
export const DEFAULT_BACKPORT_REPO = "nat-chan/zmk-keyboard-torabo-tsuki-lp";
export const DEFAULT_BACKPORT_BRANCH = "master";

/** Repo paths of the files the backport rewrites. */
export const BACKPORT_KEYMAP_PATH = "config/keymap.keymap";
export const BACKPORT_KEYMAP_JSON_PATH = "config/keymap.json";
export const BACKPORT_OVERLAY_PATHS = [
  "boards/shields/torabo_tsuki_lp/torabo_tsuki_lp_left.overlay",
  "boards/shields/torabo_tsuki_lp/torabo_tsuki_lp_right.overlay",
];

export function loadBackportToken(): string {
  try {
    return localStorage.getItem(GITHUB_BACKPORT_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveBackportToken(token: string): void {
  try {
    if (token) localStorage.setItem(GITHUB_BACKPORT_TOKEN_KEY, token);
    else localStorage.removeItem(GITHUB_BACKPORT_TOKEN_KEY);
  } catch {
    // localStorage unavailable — the token just won't persist.
  }
}

export function clearBackportToken(): void {
  saveBackportToken("");
}

/** Coarse failure classes the UI turns into i18n'd messages. */
export type GitHubErrorKind =
  | "auth" // 401/403: bad or under-scoped token
  | "conflict" // 409/422: non-fast-forward (branch moved) — retry
  | "not-found" // 404: repo/branch/file missing (or token can't see it)
  | "network" // fetch itself failed
  | "api"; // any other API error

export class GitHubBackportError extends Error {
  readonly kind: GitHubErrorKind;
  readonly status?: number;

  constructor(kind: GitHubErrorKind, message: string, status?: number) {
    super(message);
    this.name = "GitHubBackportError";
    this.kind = kind;
    this.status = status;
  }
}

async function githubFetch(
  path: string,
  token: string,
  init?: Omit<RequestInit, "headers"> & { headers?: Record<string, string> },
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init?.headers,
      },
    });
  } catch (err) {
    throw new GitHubBackportError(
      "network",
      err instanceof Error ? err.message : "network error",
    );
  }
  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { message?: string };
      detail = body.message ?? "";
    } catch {
      // Body wasn't JSON — status alone will do.
    }
    const kind: GitHubErrorKind =
      response.status === 401 || response.status === 403
        ? "auth"
        : response.status === 409 || response.status === 422
          ? "conflict"
          : response.status === 404
            ? "not-found"
            : "api";
    throw new GitHubBackportError(
      kind,
      `GitHub API ${response.status} on ${path}${detail ? `: ${detail}` : ""}`,
      response.status,
    );
  }
  return response;
}

/** Fetch one file's current content from the repo (raw, decoded). */
export async function fetchRepoFile(
  repo: string,
  branch: string,
  path: string,
  token: string,
): Promise<string> {
  const response = await githubFetch(
    `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`,
    token,
    { headers: { Accept: "application/vnd.github.raw+json" } },
  );
  return response.text();
}

export interface BackportFile {
  /** Path inside the repo, e.g. "config/keymap.keymap". */
  path: string;
  /** Full new file content (UTF-8). */
  content: string;
}

export interface BackportCommitResult {
  commitSha: string;
  /** Web URL of the created commit. */
  commitUrl: string;
}

/**
 * Create ONE atomic commit updating `files` on `branch`, via the git data
 * API: GET ref -> GET commit -> POST blobs -> POST tree -> POST commit ->
 * PATCH ref (no force). A concurrent push between GET ref and PATCH ref
 * surfaces as a "conflict" error — the caller retries.
 */
export async function commitBackport(options: {
  repo: string;
  branch: string;
  token: string;
  message: string;
  files: BackportFile[];
}): Promise<BackportCommitResult> {
  const { repo, branch, token, message, files } = options;

  // 1. Current branch head.
  const ref = (await (
    await githubFetch(`/repos/${repo}/git/ref/heads/${branch}`, token)
  ).json()) as { object: { sha: string } };
  const headSha = ref.object.sha;

  // 2. Its root tree.
  const headCommit = (await (
    await githubFetch(`/repos/${repo}/git/commits/${headSha}`, token)
  ).json()) as { tree: { sha: string } };

  // 3. One blob per file.
  const blobShas: string[] = [];
  for (const file of files) {
    const blob = (await (
      await githubFetch(`/repos/${repo}/git/blobs`, token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: file.content, encoding: "utf-8" }),
      })
    ).json()) as { sha: string };
    blobShas.push(blob.sha);
  }

  // 4. A tree with the new blobs on top of the current root tree.
  const tree = (await (
    await githubFetch(`/repos/${repo}/git/trees`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        base_tree: headCommit.tree.sha,
        tree: files.map((file, i) => ({
          path: file.path,
          mode: "100644",
          type: "blob",
          sha: blobShas[i],
        })),
      }),
    })
  ).json()) as { sha: string };

  // 5. The commit.
  const commit = (await (
    await githubFetch(`/repos/${repo}/git/commits`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, tree: tree.sha, parents: [headSha] }),
    })
  ).json()) as { sha: string };

  // 6. Fast-forward the branch (no force: a moved branch means conflict).
  await githubFetch(`/repos/${repo}/git/refs/heads/${branch}`, token, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });

  return {
    commitSha: commit.sha,
    commitUrl: `https://github.com/${repo}/commit/${commit.sha}`,
  };
}
