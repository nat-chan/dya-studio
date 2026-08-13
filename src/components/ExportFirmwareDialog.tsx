/**
 * "Export to firmware" (backport) dialog.
 *
 * Reads the CURRENT on-device state — the full keymap the keymap editor has
 * loaded plus the runtime-accel pointer/scroll curves — reverse-serializes it
 * into the firmware repo's source files (config/keymap.keymap,
 * config/keymap.json, the shield overlays' default-curve values), shows a
 * per-file unified diff against what is on GitHub right now, and commits the
 * changed files as ONE atomic commit via the GitHub git data API, straight
 * from the browser.
 *
 * The fine-grained PAT (single repo, Contents: Read and write) is kept only
 * in localStorage and never logged.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  IconAlertTriangle,
  IconCheck,
  IconExternalLink,
  IconGitCommit,
  IconInfoCircle,
  IconLoader2,
  IconRefresh,
  IconX,
} from "@tabler/icons-react";
import { Diff, Hunk } from "react-diff-view";
import "react-diff-view/style/index.css";
import { useLanguage } from "../hooks/useLanguage";
import type { UseKeymapReturn } from "../hooks/useKeymap";
import { useCustomSubsystem } from "../hooks/useCustomSubsystem";
import {
  RUNTIME_ACCEL_CODEC,
  RUNTIME_ACCEL_SUBSYSTEM_IDENTIFIER,
} from "../hooks/useRuntimeAccel";
import { Request } from "../proto/nat-chan/runtime-accel/runtime_accel";
import {
  FirmwareFormatError,
  renderKeymapJson,
  renderKeymapKeymap,
  replaceDefaultCurve,
  deriveGridRowLengths,
  serializeDeviceKeymap,
  type SerializeWarning,
} from "../lib/firmwareExport";
import {
  BACKPORT_KEYMAP_JSON_PATH,
  BACKPORT_KEYMAP_PATH,
  BACKPORT_OVERLAY_PATHS,
  DEFAULT_BACKPORT_BRANCH,
  DEFAULT_BACKPORT_REPO,
  GitHubBackportError,
  clearBackportToken,
  commitBackport,
  fetchRepoFile,
  loadBackportToken,
  saveBackportToken,
  type BackportCommitResult,
} from "../lib/githubBackport";
import { buildTextDiff } from "../lib/abyss/jsonDiff";

/** Default commit message (deliberately not translated: it is what ends up
 * in the user's git history). */
const DEFAULT_COMMIT_MESSAGE = "実機設定をデフォルトにバックポート";

interface PreparedFile {
  path: string;
  before: string;
  after: string;
  changed: boolean;
}

type Phase = "loading" | "ready" | "error" | "committing" | "done";

export function ExportFirmwareDialog({
  open,
  onOpenChange,
  keymap,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  keymap: UseKeymapReturn;
}) {
  const { t } = useLanguage();
  const accel = useCustomSubsystem(
    RUNTIME_ACCEL_SUBSYSTEM_IDENTIFIER,
    RUNTIME_ACCEL_CODEC,
  );

  const [repo, setRepo] = useState(DEFAULT_BACKPORT_REPO);
  const [branch, setBranch] = useState(DEFAULT_BACKPORT_BRANCH);
  const [token, setToken] = useState(() => loadBackportToken());
  const [message, setMessage] = useState(DEFAULT_COMMIT_MESSAGE);

  const [phase, setPhase] = useState<Phase>("loading");
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [files, setFiles] = useState<PreparedFile[]>([]);
  const [warnings, setWarnings] = useState<SerializeWarning[]>([]);
  const [curvesSkipped, setCurvesSkipped] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [result, setResult] = useState<BackportCommitResult | null>(null);

  // Serial number guarding against a stale prepare() overwriting a newer one
  // (repo/branch edited, dialog reopened) after its fetches resolve.
  const prepareTokenRef = useRef(0);

  const describeGitHubError = useCallback(
    (err: unknown): string => {
      if (err instanceof GitHubBackportError) {
        switch (err.kind) {
          case "auth":
            return t(
              "GitHub rejected the token. Use a fine-grained personal access token for {{repo}} with Contents: Read and write.",
              { repo },
            );
          case "conflict":
            return t(
              "The branch moved while committing (non-fast-forward). Refetch and try again.",
            );
          case "not-found":
            return t(
              "Repository, branch, or file not found. Check the repository and branch names; private repositories also need a token.",
            );
          case "network":
            return t(
              "Network error while talking to GitHub. Check your connection and try again.",
            );
          default:
            return t("GitHub API error: {{message}}", {
              message: err.message,
            });
        }
      }
      return err instanceof Error ? err.message : String(err);
    },
    [t, repo],
  );

  const prepare = useCallback(async () => {
    const runToken = ++prepareTokenRef.current;
    setPhase("loading");
    setPrepareError(null);
    setCommitError(null);
    setResult(null);
    try {
      if (!keymap.keymap) {
        throw new Error(t("The keymap has not been loaded yet."));
      }
      // 1. Reverse-serialize the on-device keymap.
      const serialized = serializeDeviceKeymap(keymap.keymap, keymap.behaviors);

      // 2. Read both acceleration curves from the keyboard (skipped when the
      //    runtime-accel subsystem is not available).
      const curves = new Map<string, number[]>();
      let skipped = true;
      if (accel.ready) {
        const listResponse = await accel.call(
          Request.create({ listInstances: {} }),
        );
        const ids = listResponse?.instances?.ids ?? [];
        for (const instanceId of ids) {
          const curveResponse = await accel.call(
            Request.create({ getCurve: { instanceId } }),
          );
          const points = curveResponse?.curve?.points;
          if (points) curves.set(instanceId, points);
        }
        skipped = curves.size === 0;
      }

      // 3. Fetch the current source files and generate their replacements.
      const overlayPaths = skipped ? [] : BACKPORT_OVERLAY_PATHS;
      const paths = [
        BACKPORT_KEYMAP_PATH,
        BACKPORT_KEYMAP_JSON_PATH,
        ...overlayPaths,
      ];
      const contents = await Promise.all(
        paths.map((path) => fetchRepoFile(repo, branch, path, token)),
      );
      const [keymapBefore, jsonBefore, ...overlayBefores] = contents;

      const keymapAfter = renderKeymapKeymap(keymapBefore, serialized);
      const jsonAfter = renderKeymapJson(
        jsonBefore,
        serialized,
        deriveGridRowLengths(keymapBefore),
      );
      const prepared: PreparedFile[] = [
        {
          path: BACKPORT_KEYMAP_PATH,
          before: keymapBefore,
          after: keymapAfter,
          changed: keymapAfter !== keymapBefore,
        },
        {
          path: BACKPORT_KEYMAP_JSON_PATH,
          before: jsonBefore,
          after: jsonAfter,
          changed: jsonAfter !== jsonBefore,
        },
        ...overlayPaths.map((path, i) => {
          let after = overlayBefores[i];
          for (const [instanceId, points] of curves) {
            // An instance the overlay doesn't declare is simply left alone.
            try {
              after = replaceDefaultCurve(after, instanceId, points);
            } catch {
              // instance-not-found — nothing to backport into this overlay.
            }
          }
          return {
            path,
            before: overlayBefores[i],
            after,
            changed: after !== overlayBefores[i],
          };
        }),
      ];

      if (runToken !== prepareTokenRef.current) return;
      setFiles(prepared);
      setWarnings(serialized.warnings);
      setCurvesSkipped(skipped);
      setSelectedPath(
        prepared.find((f) => f.changed)?.path ?? prepared[0].path,
      );
      setPhase("ready");
    } catch (err) {
      if (runToken !== prepareTokenRef.current) return;
      if (err instanceof FirmwareFormatError) {
        setPrepareError(
          err.reason === "key-count-mismatch"
            ? t(
                "The number of keys on the device does not match the firmware keymap file, so the keymap cannot be backported.",
              )
            : t(
                "The firmware source file has an unexpected format: {{message}}",
                { message: err.message },
              ),
        );
      } else {
        setPrepareError(describeGitHubError(err));
      }
      setPhase("error");
    }
  }, [
    keymap.keymap,
    keymap.behaviors,
    accel,
    repo,
    branch,
    token,
    t,
    describeGitHubError,
  ]);

  // Prepare when the dialog opens. Repo/branch edits require an explicit
  // Refetch (button) so typing doesn't fire a request per keystroke.
  useEffect(() => {
    if (open) {
      void prepare();
    } else {
      prepareTokenRef.current++;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const changedFiles = useMemo(() => files.filter((f) => f.changed), [files]);
  const selectedFile = files.find((f) => f.path === selectedPath) ?? null;
  const selectedDiff = useMemo(() => {
    if (!selectedFile || !selectedFile.changed) return null;
    return buildTextDiff(
      selectedFile.before,
      selectedFile.after,
      selectedFile.path,
    );
  }, [selectedFile]);

  const handleTokenChange = (value: string) => {
    setToken(value);
    saveBackportToken(value);
  };

  const handleClearToken = () => {
    setToken("");
    clearBackportToken();
  };

  const handleCommit = useCallback(async () => {
    setPhase("committing");
    setCommitError(null);
    try {
      const committed = await commitBackport({
        repo,
        branch,
        token,
        message,
        files: changedFiles.map((f) => ({ path: f.path, content: f.after })),
      });
      setResult(committed);
      setPhase("done");
    } catch (err) {
      setCommitError(describeGitHubError(err));
      setPhase("ready");
    }
  }, [repo, branch, token, message, changedFiles, describeGitHubError]);

  const fileLabel = (path: string) => path.split("/").pop() ?? path;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50" />
        <Dialog.Content
          className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[95vw] max-w-3xl max-h-[90vh] overflow-y-auto bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] shadow-2xl z-50 p-6"
          aria-describedby={undefined}
        >
          <div className="flex items-start gap-2">
            <Dialog.Title className="flex-1 text-base font-medium text-[var(--color-text)] mb-1 flex items-center gap-2">
              <IconGitCommit
                size={18}
                className="text-[var(--color-electric)]"
              />
              {t("Export to firmware")}
            </Dialog.Title>
            <Dialog.Close
              className="btn-ghost p-1.5 flex-shrink-0"
              aria-label={t("Close")}
            >
              <IconX size={16} />
            </Dialog.Close>
          </div>
          <p className="text-xs text-[var(--color-text-muted)] mb-4">
            {t(
              "Backport the current on-device keymap and acceleration curves into the firmware source repository as new compiled-in defaults. Review the diff, then commit directly to GitHub.",
            )}
          </p>

          {/* Repo / branch / token */}
          <div className="grid grid-cols-1 tablet:grid-cols-2 gap-3 mb-4">
            <label className="text-xs text-[var(--color-text-muted)]">
              {t("Repository")}
              <input
                type="text"
                className="input-field w-full text-sm mt-1"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                spellCheck={false}
              />
            </label>
            <label className="text-xs text-[var(--color-text-muted)]">
              {t("Branch")}
              <input
                type="text"
                className="input-field w-full text-sm mt-1"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                spellCheck={false}
              />
            </label>
            <div className="tablet:col-span-2">
              <label className="text-xs text-[var(--color-text-muted)] block">
                {t("GitHub token")}
                <div className="flex items-center gap-2 mt-1">
                  <input
                    type="password"
                    className="input-field flex-1 text-sm"
                    value={token}
                    onChange={(e) => handleTokenChange(e.target.value)}
                    placeholder="github_pat_..."
                    autoComplete="off"
                  />
                  <button
                    className="btn-ghost text-sm"
                    onClick={handleClearToken}
                    disabled={token.length === 0}
                  >
                    {t("Clear")}
                  </button>
                </div>
              </label>
              <p className="text-xs text-[var(--color-text-muted)] mt-1">
                {t(
                  "Fine-grained personal access token, scoped to {{repo}} only, with permission Contents: Read and write. Stored only in this browser's local storage.",
                  { repo },
                )}
              </p>
            </div>
          </div>

          {/* Preparation states */}
          {phase === "loading" && (
            <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)] py-8 justify-center">
              <IconLoader2 size={16} className="animate-spin" />
              {t("Reading device state and fetching firmware sources...")}
            </div>
          )}

          {phase === "error" && (
            <div className="space-y-3">
              <p className="text-xs text-red-400" role="alert">
                {prepareError}
              </p>
              <button
                className="btn-ghost text-sm flex items-center gap-1.5"
                onClick={() => void prepare()}
              >
                <IconRefresh size={16} />
                {t("Retry")}
              </button>
            </div>
          )}

          {(phase === "ready" || phase === "committing" || phase === "done") &&
            files.length > 0 && (
              <div className="space-y-4">
                {/* Notes */}
                {curvesSkipped && (
                  <p className="text-xs text-[var(--color-text-muted)] flex items-start gap-1.5">
                    <IconInfoCircle size={14} className="shrink-0 mt-0.5" />
                    {t(
                      "Acceleration curves could not be read from the keyboard, so the overlay files are not included in this export.",
                    )}
                  </p>
                )}
                {warnings.length > 0 && (
                  <div className="text-xs text-[var(--color-warning)] space-y-1">
                    <p className="flex items-center gap-1.5 font-medium">
                      <IconAlertTriangle size={14} />
                      {t(
                        "{{count}} bindings cannot be expressed in the firmware source and are exported as &trans:",
                        { count: warnings.length },
                      )}
                    </p>
                    <ul className="list-disc pl-5 space-y-0.5">
                      {warnings.map((w) => (
                        <li key={`${w.layerIndex}:${w.keyPosition}`}>
                          {t("Layer {{layer}}, key {{position}}: {{binding}}", {
                            layer: w.layerName,
                            position: w.keyPosition,
                            binding: w.binding,
                          })}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* File tabs + diff */}
                <div className="flex items-center gap-1 flex-wrap">
                  {files.map((file) => (
                    <button
                      key={file.path}
                      className={`px-3 py-1 rounded text-xs border transition-colors font-mono ${
                        selectedPath === file.path
                          ? "border-[var(--color-electric)] text-[var(--color-electric)] bg-[var(--color-electric)]/10"
                          : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                      }`}
                      onClick={() => setSelectedPath(file.path)}
                      title={file.path}
                    >
                      {fileLabel(file.path)}
                      {file.changed && (
                        <span className="ml-1 text-[var(--color-neon)]">●</span>
                      )}
                    </button>
                  ))}
                  <button
                    className="btn-ghost text-xs flex items-center gap-1 ml-auto"
                    onClick={() => void prepare()}
                    disabled={phase === "committing"}
                  >
                    <IconRefresh size={14} />
                    {t("Refetch")}
                  </button>
                </div>

                <div className="rounded-lg border border-[var(--color-border)] overflow-x-auto max-h-72 overflow-y-auto text-xs">
                  {selectedDiff ? (
                    selectedDiff.collapsedFiles.map((file, index) => (
                      <Diff
                        key={file.newPath ?? index}
                        diffType={file.type}
                        hunks={file.hunks}
                        viewType="unified"
                      >
                        {(hunks) =>
                          hunks.map((hunk) => (
                            <Hunk hunk={hunk} key={hunk.content} />
                          ))
                        }
                      </Diff>
                    ))
                  ) : (
                    <p className="p-3 text-[var(--color-text-muted)]">
                      {t("No changes in this file.")}
                    </p>
                  )}
                </div>

                {/* Semantics note */}
                <p className="text-xs text-[var(--color-text-muted)] flex items-start gap-1.5">
                  <IconInfoCircle size={14} className="shrink-0 mt-0.5" />
                  {t(
                    'Flashing the backported firmware will not visibly change behavior: the settings stored on the keyboard override the compiled-in defaults, and both then hold identical values — which is exactly what makes this backport harmless. To hand control back to the compiled-in defaults later, you can optionally run "Reset all settings" in the Settings tab.',
                  )}
                </p>

                {phase === "done" && result ? (
                  <div className="space-y-2" role="status">
                    <p className="text-sm text-[var(--color-neon)] flex items-center gap-1.5">
                      <IconCheck size={16} />
                      {t("Backport committed.")}
                    </p>
                    <a
                      href={result.commitUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm text-[var(--color-electric)] underline flex items-center gap-1.5"
                    >
                      {t("View commit on GitHub")}
                      <IconExternalLink size={14} />
                    </a>
                    <p className="text-xs text-[var(--color-text-muted)]">
                      {t(
                        "GitHub Actions now builds the new firmware automatically — download it from the repository's Actions page once the build finishes.",
                      )}
                    </p>
                  </div>
                ) : (
                  <>
                    {/* Commit message + button */}
                    <label className="text-xs text-[var(--color-text-muted)] block">
                      {t("Commit message")}
                      <input
                        type="text"
                        className="input-field w-full text-sm mt-1"
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                      />
                    </label>
                    {changedFiles.length === 0 && (
                      <p className="text-xs text-[var(--color-text-muted)]">
                        {t(
                          "Everything is up to date — the firmware defaults already match the current device state.",
                        )}
                      </p>
                    )}
                    {commitError && (
                      <p className="text-xs text-red-400" role="alert">
                        {commitError}
                      </p>
                    )}
                    <button
                      className="btn-electric w-full flex items-center justify-center gap-2"
                      onClick={() => void handleCommit()}
                      disabled={
                        phase === "committing" ||
                        changedFiles.length === 0 ||
                        token.trim().length === 0 ||
                        message.trim().length === 0
                      }
                      title={
                        token.trim().length === 0
                          ? t("Enter a GitHub token to commit.")
                          : undefined
                      }
                    >
                      {phase === "committing" ? (
                        <IconLoader2 size={16} className="animate-spin" />
                      ) : (
                        <IconGitCommit size={16} />
                      )}
                      {t("Commit {{count}} files to {{branch}}", {
                        count: changedFiles.length,
                        branch,
                      })}
                    </button>
                  </>
                )}
              </div>
            )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
