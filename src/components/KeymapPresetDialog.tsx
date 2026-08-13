import { useCallback, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  IconArrowRight,
  IconLoader2,
  IconTemplate,
  IconAlertTriangle,
} from "@tabler/icons-react";
import type { PhysicalLayout } from "@zmkfirmware/zmk-studio-ts-client/keymap";
import type { UseKeymapReturn } from "../hooks/useKeymap";
import { useLanguage } from "../hooks/useLanguage";
import {
  computePresetDiff,
  resolvePresetBinding,
  buildBehaviorIdIndex,
  type KeymapPresetDefinition,
  type PresetDiff,
  type PresetDiffEntry,
} from "../lib/keymapPreset";
import { KEYMAP_PRESETS } from "../presets";

/**
 * Built-in keymap preset picker with diff review.
 *
 * Flow: pick a preset -> review a visual diff against the keymap currently
 * loaded from the keyboard (mini-map highlights + before/after list) ->
 * Apply stages the changes through the ordinary keymap edit RPCs
 * (addLayer / setLayerProps / setLayerBinding). Nothing is saved to flash:
 * the user then uses the keymap editor's regular Save / Discard buttons.
 * Bindings the connected keyboard cannot express (missing behavior, key
 * position out of range) are marked unappliable and skipped instead of
 * failing the whole apply.
 */
export function KeymapPresetDialog({
  open,
  onOpenChange,
  keymap,
  physicalLayout,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  keymap: UseKeymapReturn;
  physicalLayout: PhysicalLayout | null;
}) {
  const { t } = useLanguage();
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [selectedLayerIndex, setSelectedLayerIndex] = useState(0);
  const [isApplying, setIsApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<{
    applied: number;
    failed: number;
    skipped: number;
  } | null>(null);

  const preset: KeymapPresetDefinition | null =
    KEYMAP_PRESETS.find((p) => p.id === selectedPresetId) ?? null;

  const diff: PresetDiff | null = useMemo(() => {
    if (!preset || !keymap.keymap) return null;
    return computePresetDiff(preset.keymap, keymap.keymap, keymap.behaviors);
  }, [preset, keymap.keymap, keymap.behaviors]);

  const reset = useCallback(() => {
    setSelectedPresetId(null);
    setSelectedLayerIndex(0);
    setApplyResult(null);
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) reset();
      onOpenChange(next);
    },
    [onOpenChange, reset],
  );

  const handleApply = useCallback(async () => {
    if (!preset || !diff || !keymap.keymap) return;
    setIsApplying(true);
    setApplyResult(null);
    try {
      let applied = 0;
      let failed = 0;
      let skipped = 0;

      // 1. Add missing layers, collecting their fresh device ids so `&lt`
      //    bindings that target them can be resolved below.
      const layerIds: Array<number | null> = preset.keymap.layers.map(
        (_, i) => keymap.keymap?.layers[i]?.id ?? null,
      );
      if (diff.canAddLayers) {
        for (let i = 0; i < layerIds.length; i++) {
          if (layerIds[i] !== null) continue;
          const added = await keymap.addLayer();
          if (!added) {
            failed++;
            continue;
          }
          layerIds[i] = added.layer.id;
        }
      }

      // 2. Layer names.
      for (const layer of diff.layers) {
        const layerId = layerIds[layer.layerIndex];
        if (layerId === null || !layer.nameChanged) continue;
        const ok = await keymap.setLayerName(layerId, layer.presetName);
        if (!ok) failed++;
      }

      // 3. Bindings. Re-resolve each entry against the final layer ids so
      //    `&lt` into a just-added layer gets its real id, then stage via the
      //    standard setLayerBinding RPC. Unappliable entries are skipped.
      const behaviorIds = buildBehaviorIdIndex(keymap.behaviors);
      for (const layer of diff.layers) {
        const layerId = layerIds[layer.layerIndex];
        if (layerId === null) {
          skipped += layer.entries.filter((e) => e.status === "change").length;
          continue;
        }
        for (const entry of layer.entries) {
          if (entry.status === "unappliable") {
            skipped++;
            continue;
          }
          if (entry.status !== "change" || !entry.parsed) continue;
          const resolved = resolvePresetBinding(
            entry.parsed,
            behaviorIds,
            layerIds,
          );
          if (!resolved.ok) {
            skipped++;
            continue;
          }
          const ok = await keymap.setBinding(
            layerId,
            entry.keyPosition,
            resolved.binding,
          );
          if (ok) applied++;
          else failed++;
        }
      }
      setApplyResult({ applied, failed, skipped });
    } finally {
      setIsApplying(false);
    }
  }, [preset, diff, keymap]);

  const currentDiffLayer = diff?.layers[selectedLayerIndex] ?? null;
  const changedEntries =
    currentDiffLayer?.entries.filter((e) => e.status !== "same") ?? [];

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50" />
        <Dialog.Content
          className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[92vw] max-w-2xl max-h-[85vh] overflow-y-auto bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] shadow-2xl z-50 p-6"
          aria-describedby={undefined}
        >
          <Dialog.Title className="text-base font-medium text-[var(--color-text)] mb-1 flex items-center gap-2">
            <IconTemplate size={18} className="text-[var(--color-electric)]" />
            {t("Keymap Presets")}
          </Dialog.Title>
          <p className="text-xs text-[var(--color-text-muted)] mb-4">
            {t(
              "Apply a built-in keymap. Changes are staged on the keyboard — review them, then Save or Discard from the keymap editor.",
            )}
          </p>

          {/* Step 1: preset picker */}
          {!preset && (
            <div className="space-y-2">
              {KEYMAP_PRESETS.map((p) => (
                <button
                  key={p.id}
                  className="w-full text-left glass-card p-4 hover:border-[var(--color-electric)] transition-colors"
                  onClick={() => setSelectedPresetId(p.id)}
                >
                  <p className="text-sm font-medium text-[var(--color-text)]">
                    {t(p.name)}
                  </p>
                  <p className="text-xs text-[var(--color-text-muted)] mt-1">
                    {t(p.description)}
                  </p>
                  <p className="text-xs text-[var(--color-text-muted)] mt-1 font-mono">
                    {p.keymap.layer_names.join(" / ")} ·{" "}
                    {t("{{count}} keys", {
                      count: p.keymap.layers[0]?.length ?? 0,
                    })}
                  </p>
                </button>
              ))}
            </div>
          )}

          {/* Step 2: diff review */}
          {preset && diff && (
            <div className="space-y-4">
              {/* Summary */}
              <div className="flex items-center gap-3 flex-wrap text-xs">
                <span className="px-2 py-1 rounded-full bg-[var(--color-electric)]/10 text-[var(--color-electric)]">
                  {t("{{count}} changes", { count: diff.counts.change })}
                </span>
                <span className="px-2 py-1 rounded-full bg-[var(--color-border)] text-[var(--color-text-muted)]">
                  {t("{{count}} unchanged", { count: diff.counts.same })}
                </span>
                {diff.counts.unappliable > 0 && (
                  <span className="px-2 py-1 rounded-full bg-red-500/10 text-red-400">
                    {t("{{count}} not appliable", {
                      count: diff.counts.unappliable,
                    })}
                  </span>
                )}
                {diff.layersToAdd > 0 && (
                  <span className="px-2 py-1 rounded-full bg-[var(--color-cyber)]/10 text-[var(--color-cyber)]">
                    {t("{{count}} layers to add", { count: diff.layersToAdd })}
                  </span>
                )}
              </div>

              {diff.layersToAdd > 0 && !diff.canAddLayers && (
                <p className="text-xs text-red-400 flex items-center gap-1">
                  <IconAlertTriangle size={14} />
                  {t(
                    "The keyboard does not have enough free layer slots for this preset. Missing layers are skipped.",
                  )}
                </p>
              )}

              {/* Layer tabs */}
              <div className="flex items-center gap-1 flex-wrap">
                {diff.layers.map((layer) => {
                  const changes = layer.entries.filter(
                    (e) => e.status === "change",
                  ).length;
                  return (
                    <button
                      key={layer.layerIndex}
                      className={`px-3 py-1 rounded text-xs border transition-colors ${
                        selectedLayerIndex === layer.layerIndex
                          ? "border-[var(--color-electric)] text-[var(--color-electric)] bg-[var(--color-electric)]/10"
                          : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                      }`}
                      onClick={() => setSelectedLayerIndex(layer.layerIndex)}
                    >
                      {layer.presetName}
                      {changes > 0 && (
                        <span className="ml-1 text-[var(--color-neon)]">
                          {changes}
                        </span>
                      )}
                      {layer.layerId === null && (
                        <span className="ml-1 text-[var(--color-cyber)]">
                          +
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Mini-map: highlight keys that would change */}
              {physicalLayout && currentDiffLayer && (
                <PresetDiffMiniMap
                  layout={physicalLayout}
                  entries={currentDiffLayer.entries}
                />
              )}

              {/* Before/after list */}
              <div className="max-h-56 overflow-y-auto rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
                {changedEntries.length === 0 && (
                  <p className="p-3 text-xs text-[var(--color-text-muted)]">
                    {t("This layer already matches the preset.")}
                  </p>
                )}
                {changedEntries.map((entry) => (
                  <div
                    key={entry.keyPosition}
                    className="flex items-center gap-2 px-3 py-1.5 text-xs"
                  >
                    <span className="w-10 shrink-0 font-mono text-[var(--color-text-muted)]">
                      #{entry.keyPosition}
                    </span>
                    <span className="flex-1 truncate text-[var(--color-text-secondary)]">
                      {entry.current
                        ? keymap.getBindingDisplayName(entry.current)
                        : "—"}
                    </span>
                    <IconArrowRight
                      size={12}
                      className="shrink-0 text-[var(--color-text-muted)]"
                    />
                    <span
                      className={`flex-1 truncate font-mono ${
                        entry.status === "unappliable"
                          ? "text-red-400 line-through"
                          : "text-[var(--color-electric)]"
                      }`}
                      title={
                        entry.status === "unappliable"
                          ? t("Not appliable on this keyboard ({{reason}})", {
                              reason: entry.reason ?? "unknown",
                            })
                          : undefined
                      }
                    >
                      {entry.presetText}
                    </span>
                  </div>
                ))}
              </div>

              {applyResult && (
                <p
                  className="text-xs text-[var(--color-neon)]"
                  role="status"
                  data-testid="preset-apply-result"
                >
                  {t(
                    "Preset staged: {{applied}} keys changed, {{skipped}} skipped, {{failed}} failed. Use Save to persist or Discard to revert.",
                    {
                      applied: applyResult.applied,
                      skipped: applyResult.skipped,
                      failed: applyResult.failed,
                    },
                  )}
                </p>
              )}

              {/* Actions */}
              <div className="flex gap-3">
                <button
                  className="flex-1 btn-ghost border border-[var(--color-border)]"
                  onClick={() => reset()}
                  disabled={isApplying}
                >
                  {t("Back")}
                </button>
                {applyResult ? (
                  <button
                    className="flex-1 btn-electric"
                    onClick={() => handleOpenChange(false)}
                  >
                    {t("Close")}
                  </button>
                ) : (
                  <button
                    className="flex-1 btn-electric flex items-center justify-center gap-2"
                    onClick={() => void handleApply()}
                    disabled={isApplying || diff.counts.change === 0}
                  >
                    {isApplying && (
                      <IconLoader2 size={16} className="animate-spin" />
                    )}
                    {t("Apply Preset")}
                  </button>
                )}
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Compact physical mini-map of one layer: each key is a small rectangle,
 * colored by diff status (changed = electric, unappliable = red, same =
 * border). Rotation is ignored — this is an overview, not the editor.
 */
function PresetDiffMiniMap({
  layout,
  entries,
}: {
  layout: PhysicalLayout;
  entries: PresetDiffEntry[];
}) {
  const keys = layout.keys;
  if (keys.length === 0) return null;
  const minX = Math.min(...keys.map((k) => k.x));
  const minY = Math.min(...keys.map((k) => k.y));
  const maxX = Math.max(...keys.map((k) => k.x + k.width));
  const maxY = Math.max(...keys.map((k) => k.y + k.height));
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const statusByPosition = new Map(
    entries.map((e) => [e.keyPosition, e.status]),
  );

  return (
    <svg
      viewBox={`0 0 ${spanX} ${spanY}`}
      className="w-full max-h-40"
      role="img"
      aria-label="Preset diff overview"
      data-testid="preset-diff-minimap"
    >
      {keys.map((key, position) => {
        const status = statusByPosition.get(position);
        const fill =
          status === "change"
            ? "var(--color-electric)"
            : status === "unappliable"
              ? "#f87171"
              : "var(--color-border)";
        return (
          <rect
            key={position}
            x={key.x - minX + 1}
            y={key.y - minY + 1}
            width={Math.max(1, key.width - 2)}
            height={Math.max(1, key.height - 2)}
            rx={2}
            fill={fill}
            opacity={
              status === "change" || status === "unappliable" ? 0.9 : 0.35
            }
          />
        );
      })}
    </svg>
  );
}
