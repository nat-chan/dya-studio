import { useCallback, useEffect, useRef, useState } from "react";
import { useCustomSubsystem } from "./useCustomSubsystem";
import {
  Request,
  Response,
} from "../proto/nat-chan/runtime-accel/runtime_accel";
import { type CurvePoint, toPairs, toInterleaved } from "../lib/accelCurve";
import { studioLockErrorText } from "../lib/studioUnlock";

export const RUNTIME_ACCEL_SUBSYSTEM_IDENTIFIER = "nat_chan__runtime_accel";

const CODEC = {
  encode: (request: Request) => Request.encode(request).finish(),
  decode: (payload: Uint8Array) => Response.decode(payload),
};

export interface UseRuntimeAccelReturn {
  /** The nat_chan__runtime_accel subsystem exists in the connected firmware. */
  isAvailable: boolean;
  /** Instance ids reported by ListInstances, or null before the first load. */
  instances: string[] | null;
  selectedId: string | null;
  /** Working copy of the selected instance's curve control points. */
  pairs: CurvePoint[];
  isLoading: boolean;
  isBusy: boolean;
  error: string | null;
  /** Human-readable result of the last Apply/Save, or null. */
  lastAction: "applied" | "saved" | null;
  refresh: () => Promise<void>;
  selectInstance: (id: string) => Promise<void>;
  /** Replace the working curve locally (drag/type/add/remove point). */
  editPairs: (updater: (prev: CurvePoint[]) => CurvePoint[]) => void;
  /**
   * Send the working curve to the firmware. persist=false stages it in RAM
   * only; persist=true also saves it to flash. The firmware sanitizes
   * (clamps factors, sorts by speed) on apply, so the curve is reloaded
   * afterwards to reflect what is actually active.
   */
  setCurve: (persist: boolean) => Promise<void>;
}

export function useRuntimeAccel(): UseRuntimeAccelReturn {
  // `call` is unlock-gated by the shared useCustomSubsystem wrapper: a locked
  // (SECURED) call opens the unlock modal and is retried after unlock.
  const { subsystem, ready, call } = useCustomSubsystem(
    RUNTIME_ACCEL_SUBSYSTEM_IDENTIFIER,
    CODEC,
  );
  const [instances, setInstances] = useState<string[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pairs, setPairs] = useState<CurvePoint[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<"applied" | "saved" | null>(
    null,
  );

  // Guards against a stale GetCurve response overwriting newer state: every
  // local edit or newer load bumps the token, and an in-flight load only
  // applies its result if the token is unchanged when it resolves.
  const curveLoadTokenRef = useRef(0);
  // Fire the initial ListInstances exactly once per mount/connection.
  const initialLoadStartedRef = useRef(false);

  const runCall = useCallback(
    async (request: Request): Promise<Response | null> => {
      if (!ready) return null;
      try {
        const resp = await call(request);
        if (resp?.error) {
          setError(resp.error.message);
          return null;
        }
        return resp ?? null;
      } catch (err) {
        const locked = studioLockErrorText(err);
        setError(
          locked ?? (err instanceof Error ? err.message : "Unknown error"),
        );
        return null;
      }
    },
    [ready, call],
  );

  const loadCurve = useCallback(
    async (instanceId: string) => {
      const token = ++curveLoadTokenRef.current;
      const resp = await runCall(Request.create({ getCurve: { instanceId } }));
      if (resp?.curve && token === curveLoadTokenRef.current) {
        setPairs(toPairs(resp.curve.points));
      }
    },
    [runCall],
  );

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const resp = await runCall(Request.create({ listInstances: {} }));
      if (!resp?.instances) return;
      const ids = resp.instances.ids;
      setInstances(ids);
      const first = ids[0];
      if (first) {
        setSelectedId((prev) => (prev && ids.includes(prev) ? prev : first));
        await loadCurve(first);
      }
    } finally {
      setIsLoading(false);
    }
  }, [runCall, loadCurve]);

  const selectInstance = useCallback(
    async (id: string) => {
      setSelectedId(id);
      setError(null);
      setLastAction(null);
      await loadCurve(id);
    },
    [loadCurve],
  );

  /** Local edits invalidate any in-flight curve load (see curveLoadTokenRef). */
  const editPairs = useCallback(
    (updater: (prev: CurvePoint[]) => CurvePoint[]) => {
      curveLoadTokenRef.current++;
      setLastAction(null);
      setPairs(updater);
    },
    [],
  );

  const setCurve = useCallback(
    async (persist: boolean) => {
      if (!selectedId) return;
      setIsBusy(true);
      setError(null);
      setLastAction(null);
      try {
        const resp = await runCall(
          Request.create({
            setCurve: {
              instanceId: selectedId,
              points: toInterleaved(pairs),
              persist,
            },
          }),
        );
        if (resp?.ack) {
          setLastAction(persist ? "saved" : "applied");
          // Reload: the firmware sanitizes (clamps/sorts) on apply.
          await loadCurve(selectedId);
        }
      } finally {
        setIsBusy(false);
      }
    },
    [selectedId, pairs, runCall, loadCurve],
  );

  // Auto-fetch the instance list when the subsystem becomes available.
  useEffect(() => {
    if (ready && !initialLoadStartedRef.current) {
      initialLoadStartedRef.current = true;
      void refresh();
    }
  }, [ready, refresh]);

  return {
    isAvailable: subsystem !== null,
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
  };
}
