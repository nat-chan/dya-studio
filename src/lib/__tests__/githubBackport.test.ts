/**
 * GitHub git-data client for the firmware backport: token storage, file
 * reads, and the atomic commit sequence (ref -> commit -> blobs -> tree ->
 * commit -> ref patch), with fetch fully mocked.
 */
import {
  GITHUB_BACKPORT_TOKEN_KEY,
  GitHubBackportError,
  clearBackportToken,
  commitBackport,
  fetchRepoFile,
  loadBackportToken,
  saveBackportToken,
} from "../githubBackport";

// jsdom has no fetch — install a mock global for these tests.
const fetchMock = jest.fn<
  Promise<Response>,
  [RequestInfo | URL, RequestInit?]
>();
const originalFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  fetchMock.mockReset();
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function textResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(body),
    text: async () => body,
  } as unknown as Response;
}

describe("token storage", () => {
  afterEach(() => localStorage.clear());

  it("persists, loads, and clears the token via localStorage only", () => {
    saveBackportToken("github_pat_secret");
    expect(localStorage.getItem(GITHUB_BACKPORT_TOKEN_KEY)).toBe(
      "github_pat_secret",
    );
    expect(loadBackportToken()).toBe("github_pat_secret");
    clearBackportToken();
    expect(localStorage.getItem(GITHUB_BACKPORT_TOKEN_KEY)).toBeNull();
    expect(loadBackportToken()).toBe("");
  });
});

describe("fetchRepoFile", () => {
  it("requests the raw file content at the given ref", async () => {
    fetchMock.mockResolvedValue(textResponse("file body"));
    const content = await fetchRepoFile(
      "nat-chan/zmk-keyboard-torabo-tsuki-lp",
      "master",
      "config/keymap.keymap",
      "tok",
    );
    expect(content).toBe("file body");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://api.github.com/repos/nat-chan/zmk-keyboard-torabo-tsuki-lp/contents/config/keymap.keymap?ref=master",
    );
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Accept).toBe("application/vnd.github.raw+json");
    expect(headers.Authorization).toBe("Bearer tok");
  });

  it("maps 404 to a not-found error", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "Not Found" }, 404));
    await expect(
      fetchRepoFile("o/r", "master", "nope.txt", ""),
    ).rejects.toMatchObject({ kind: "not-found", status: 404 });
  });
});

describe("commitBackport", () => {
  const options = {
    repo: "nat-chan/zmk-keyboard-torabo-tsuki-lp",
    branch: "master",
    token: "tok",
    message: "実機設定をデフォルトにバックポート",
    files: [
      { path: "config/keymap.keymap", content: "keymap-content" },
      { path: "config/keymap.json", content: "json-content" },
    ],
  };

  it("builds one atomic commit: ref -> commit -> blobs -> tree -> commit -> ref", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ object: { sha: "head-sha" } }))
      .mockResolvedValueOnce(jsonResponse({ tree: { sha: "root-tree" } }))
      .mockResolvedValueOnce(jsonResponse({ sha: "blob-1" }))
      .mockResolvedValueOnce(jsonResponse({ sha: "blob-2" }))
      .mockResolvedValueOnce(jsonResponse({ sha: "new-tree" }))
      .mockResolvedValueOnce(jsonResponse({ sha: "new-commit" }))
      .mockResolvedValueOnce(jsonResponse({ ref: "refs/heads/master" }));

    const result = await commitBackport(options);
    expect(result).toEqual({
      commitSha: "new-commit",
      commitUrl:
        "https://github.com/nat-chan/zmk-keyboard-torabo-tsuki-lp/commit/new-commit",
    });

    const calls = fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: (init as RequestInit)?.method ?? "GET",
      body: (init as RequestInit)?.body
        ? JSON.parse(String((init as RequestInit).body))
        : null,
    }));
    const base =
      "https://api.github.com/repos/nat-chan/zmk-keyboard-torabo-tsuki-lp";
    expect(calls[0]).toMatchObject({
      url: `${base}/git/ref/heads/master`,
      method: "GET",
    });
    expect(calls[1]).toMatchObject({
      url: `${base}/git/commits/head-sha`,
      method: "GET",
    });
    expect(calls[2]).toMatchObject({
      url: `${base}/git/blobs`,
      method: "POST",
      body: { content: "keymap-content", encoding: "utf-8" },
    });
    expect(calls[3]).toMatchObject({
      url: `${base}/git/blobs`,
      method: "POST",
      body: { content: "json-content", encoding: "utf-8" },
    });
    expect(calls[4]).toMatchObject({
      url: `${base}/git/trees`,
      method: "POST",
      body: {
        base_tree: "root-tree",
        tree: [
          {
            path: "config/keymap.keymap",
            mode: "100644",
            type: "blob",
            sha: "blob-1",
          },
          {
            path: "config/keymap.json",
            mode: "100644",
            type: "blob",
            sha: "blob-2",
          },
        ],
      },
    });
    expect(calls[5]).toMatchObject({
      url: `${base}/git/commits`,
      method: "POST",
      body: {
        message: options.message,
        tree: "new-tree",
        parents: ["head-sha"],
      },
    });
    expect(calls[6]).toMatchObject({
      url: `${base}/git/refs/heads/master`,
      method: "PATCH",
      body: { sha: "new-commit", force: false },
    });

    // Every request authenticates with the token, and nothing else.
    for (const [, init] of fetchMock.mock.calls) {
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer tok");
    }
  });

  it("maps 401 to an auth error", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ message: "Bad credentials" }, 401),
    );
    await expect(commitBackport(options)).rejects.toMatchObject({
      kind: "auth",
      status: 401,
    });
  });

  it("maps a non-fast-forward 422 on the ref update to a conflict error", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ object: { sha: "head-sha" } }))
      .mockResolvedValueOnce(jsonResponse({ tree: { sha: "root-tree" } }))
      .mockResolvedValueOnce(jsonResponse({ sha: "blob-1" }))
      .mockResolvedValueOnce(jsonResponse({ sha: "blob-2" }))
      .mockResolvedValueOnce(jsonResponse({ sha: "new-tree" }))
      .mockResolvedValueOnce(jsonResponse({ sha: "new-commit" }))
      .mockResolvedValueOnce(
        jsonResponse({ message: "Update is not a fast forward" }, 422),
      );
    await expect(commitBackport(options)).rejects.toMatchObject({
      kind: "conflict",
      status: 422,
    });
  });

  it("maps a failed fetch to a network error", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const error = await commitBackport(options).catch((e) => e);
    expect(error).toBeInstanceOf(GitHubBackportError);
    expect(error.kind).toBe("network");
  });
});
