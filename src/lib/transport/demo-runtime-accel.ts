/**
 * Demo Runtime Accel Custom Subsystem Handler
 *
 * Simulates the nat_chan__runtime_accel subsystem (see
 * proto/nat-chan/runtime-accel/runtime_accel.proto): two input-processor
 * instances ("pointer" and "scroll") with editable piecewise-linear
 * speed -> factor acceleration curves. Mirrors the firmware's sanitizer on
 * SetCurve: even element count, factors clamped to 100..20000, points
 * sorted by speed, at most 8 points.
 */

import type {
  Request,
  Response,
} from "../../proto/nat-chan/runtime-accel/runtime_accel";

export const RUNTIME_ACCEL_IDENTIFIER = "nat_chan__runtime_accel";

const FACTOR_MIN = 100;
const FACTOR_MAX = 20000;
const MAX_POINTS = 8;

/** Sanitize an interleaved [s0, f0, s1, f1, ...] list like the firmware. */
export function sanitizeCurvePoints(points: number[]): number[] {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i + 1 < points.length && pairs.length < MAX_POINTS; i += 2) {
    const speed = Math.max(0, Math.trunc(points[i]));
    const factor = Math.min(
      FACTOR_MAX,
      Math.max(FACTOR_MIN, Math.trunc(points[i + 1])),
    );
    pairs.push([speed, factor]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  return pairs.flat();
}

const DEFAULT_CURVES: Record<string, number[]> = {
  pointer: [0, 1000, 1000, 2000, 3000, 3500],
  scroll: [0, 1000, 2000, 2000],
};

export class RuntimeAccelHandler {
  /** RAM (active) curves. */
  private curves = new Map<string, number[]>(
    Object.entries(DEFAULT_CURVES).map(([id, pts]) => [id, [...pts]]),
  );

  process(request: Request): Response {
    if (request.listInstances !== undefined) {
      return { instances: { ids: Array.from(this.curves.keys()) } };
    }

    if (request.getCurve !== undefined) {
      const { instanceId } = request.getCurve;
      const points = this.curves.get(instanceId);
      if (!points) {
        return { error: { message: `Unknown instance id: ${instanceId}` } };
      }
      return { curve: { instanceId, points: [...points] } };
    }

    if (request.setCurve !== undefined) {
      const { instanceId, points } = request.setCurve;
      if (!this.curves.has(instanceId)) {
        return { error: { message: `Unknown instance id: ${instanceId}` } };
      }
      if (points.length < 2) {
        return { error: { message: "Curve needs at least one point" } };
      }
      // persist=true would additionally write to flash on real firmware; the
      // demo has no reboot, so RAM and flash behave identically here.
      this.curves.set(instanceId, sanitizeCurvePoints(points));
      return { ack: {} };
    }

    return { error: { message: "Not implemented" } };
  }
}
