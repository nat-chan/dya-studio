import { IconChartLine, IconPlus, IconRefresh } from "@tabler/icons-react";

import { AccelCurveEditor } from "../components/AccelCurveEditor";
import { LoadingIndicator } from "../components/LoadingIndicator";
import { useLanguage } from "../hooks/useLanguage";
import { useRuntimeAccel } from "../hooks/useRuntimeAccel";
import {
  type CurvePoint,
  FACTOR_MIN,
  FACTOR_MAX,
  MAX_POINTS,
  SPEED_MAX,
} from "../lib/accelCurve";

/**
 * Editor for the nat_chan__runtime_accel custom subsystem: piecewise-linear
 * pointer/scroll acceleration curves (speed in counts/sec -> factor in
 * permille), editable at runtime without reflashing.
 */
export function AccelerationPage() {
  const { t } = useLanguage();
  const {
    isAvailable,
    instances,
    selectedId,
    pairs,
    isLoading,
    isBusy,
    error,
    lastAction,
    refresh,
    selectInstance,
    editPairs,
    setCurve,
  } = useRuntimeAccel();

  const updatePoint = (index: number, patch: Partial<CurvePoint>) => {
    editPairs((prev) =>
      prev.map((p, i) => (i === index ? { ...p, ...patch } : p)),
    );
  };

  const addPoint = () => {
    editPairs((prev) => {
      if (prev.length >= MAX_POINTS) return prev;
      const last = prev[prev.length - 1];
      const next: CurvePoint = last
        ? { speed: last.speed + 500, factor: last.factor }
        : { speed: 0, factor: 1000 };
      return [...prev, next];
    });
  };

  const removePoint = (index: number) => {
    editPairs((prev) =>
      prev.length > 1 ? prev.filter((_, i) => i !== index) : prev,
    );
  };

  return (
    <div className="p-6 h-full overflow-auto">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <div className="p-2 rounded-lg bg-[var(--color-electric)]/10 border border-[var(--color-electric)]/20">
            <IconChartLine size={24} className="text-[var(--color-electric)]" />
          </div>
          <div className="flex-1">
            <h1 className="text-xl font-medium text-[var(--color-text)]">
              {t("Pointer Acceleration")}
            </h1>
            <p className="text-sm text-[var(--color-text-muted)]">
              {t(
                "Tune speed-to-factor acceleration curves of the runtime-accel input processor in real time.",
              )}
            </p>
          </div>
          {isAvailable && (
            <button
              className="btn-ghost flex items-center gap-2 text-sm"
              onClick={() => void refresh()}
              disabled={isLoading}
            >
              <IconRefresh size={16} />
              {t("Refresh")}
            </button>
          )}
        </div>

        <div className="space-y-6">
          {!isAvailable && (
            <div className="glass-card p-6">
              <p className="text-sm text-[var(--color-text-secondary)]">
                {t(
                  "Runtime acceleration subsystem is not available for your keyboard.",
                )}
              </p>
              <p className="text-xs text-[var(--color-text-muted)] mt-2">
                {t(
                  "Build your firmware with the nat-chan/zmk-module-runtime-accel module to enable this feature.",
                )}
              </p>
            </div>
          )}

          {isAvailable && isLoading && instances === null && (
            <LoadingIndicator label={t("Loading acceleration curves...")} />
          )}

          {isAvailable && instances !== null && instances.length === 0 && (
            <div className="glass-card p-6">
              <p className="text-sm text-[var(--color-text-secondary)]">
                {t(
                  "No runtime-accel instances in this firmware. Add zmk,input-processor-runtime-accel nodes to your devicetree.",
                )}
              </p>
            </div>
          )}

          {isAvailable && instances !== null && instances.length > 0 && (
            <div className="glass-card p-6">
              {/* Instance selector */}
              <div
                className="flex items-center gap-2 mb-4 flex-wrap"
                role="group"
                aria-label={t("Instance")}
              >
                <span className="text-sm text-[var(--color-text-secondary)]">
                  {t("Instance")}:
                </span>
                {instances.map((id) => (
                  <button
                    key={id}
                    className={
                      selectedId === id
                        ? "btn-electric text-sm px-3 py-1"
                        : "btn-ghost text-sm px-3 py-1"
                    }
                    aria-pressed={selectedId === id}
                    onClick={() => void selectInstance(id)}
                  >
                    {id}
                  </button>
                ))}
              </div>

              <AccelCurveEditor
                pairs={pairs}
                onChange={(next) => editPairs(() => next)}
                ariaLabel={t("Acceleration curve")}
              />

              {/* Point list */}
              <div className="space-y-2 mt-4">
                {pairs.map((p, i) => (
                  <div className="flex items-center gap-3 flex-wrap" key={i}>
                    <label className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                      {t("Speed")}
                      <input
                        type="number"
                        min={0}
                        max={SPEED_MAX}
                        className="input-field w-24 text-sm"
                        aria-label={`point ${i} speed`}
                        value={p.speed}
                        onChange={(e) =>
                          updatePoint(i, {
                            speed: Math.min(
                              SPEED_MAX,
                              Math.max(0, parseInt(e.target.value) || 0),
                            ),
                          })
                        }
                      />
                    </label>
                    <label className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                      {t("Factor")}
                      <input
                        type="number"
                        min={FACTOR_MIN}
                        max={FACTOR_MAX}
                        className="input-field w-24 text-sm"
                        aria-label={`point ${i} factor`}
                        value={p.factor}
                        onChange={(e) =>
                          updatePoint(i, {
                            factor: parseInt(e.target.value) || 0,
                          })
                        }
                      />
                    </label>
                    <button
                      className="btn-ghost text-sm"
                      aria-label={`remove point ${i}`}
                      disabled={pairs.length <= 1}
                      onClick={() => removePoint(i)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 mt-4 flex-wrap">
                <button
                  className="btn-ghost flex items-center gap-1 text-sm"
                  disabled={pairs.length >= MAX_POINTS}
                  onClick={addPoint}
                >
                  <IconPlus size={16} />
                  {t("Add Point")}
                </button>
                <button
                  className="btn-neon text-sm"
                  disabled={isBusy || pairs.length === 0}
                  onClick={() => void setCurve(false)}
                >
                  {isBusy ? t("Applying...") : t("Apply (RAM)")}
                </button>
                <button
                  className="btn-electric text-sm"
                  disabled={isBusy || pairs.length === 0}
                  onClick={() => void setCurve(true)}
                >
                  {t("Save to Flash")}
                </button>
                {lastAction === "applied" && (
                  <span
                    className="text-xs text-[var(--color-neon)]"
                    data-testid="accel-status"
                  >
                    {t("Applied (RAM only)")}
                  </span>
                )}
                {lastAction === "saved" && (
                  <span
                    className="text-xs text-[var(--color-neon)]"
                    data-testid="accel-status"
                  >
                    {t("Saved to flash")}
                  </span>
                )}
              </div>

              {error && (
                <p className="text-xs text-red-400 mt-3" role="alert">
                  {error}
                </p>
              )}
            </div>
          )}

          {/* Info/Help Box */}
          <div className="mt-8 p-4 rounded-lg bg-[var(--color-border)] border border-[var(--color-border-hover)]">
            <p className="text-xs text-[var(--color-text-muted)]">
              {t(
                "Factor is permille: 1000 = 1.0x. Speed is counts/sec. The firmware clamps factors to {{min}}..{{max}} and sorts points by speed on apply. Drag points on the chart, or double-click a point to remove it.",
                { min: FACTOR_MIN, max: FACTOR_MAX },
              )}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
