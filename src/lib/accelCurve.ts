/**
 * Curve model helpers for the runtime-accel acceleration curve editor.
 *
 * The firmware exchanges curves as an interleaved control-point list
 * [s0, f0, s1, f1, ...] (speed in counts/sec, factor in permille;
 * 1000 = 1.0x) — see proto/nat-chan/runtime-accel/runtime_accel.proto.
 * Ported from nat-chan/zmk-module-runtime-accel web/src/curve.ts.
 */

export interface CurvePoint {
  speed: number;
  factor: number;
}

/** Firmware clamps factors to this range on apply (permille, 1000 = 1.0x). */
export const FACTOR_MIN = 100;
export const FACTOR_MAX = 20000;
/** Firmware clamps speeds to this range on apply (ACCEL_SPEED_MAX, counts/s).
 * Also keeps every wire value well inside sint32 for the protobuf encoder. */
export const SPEED_MIN = 0;
export const SPEED_MAX = 1000000;
/** Firmware accepts 1..8 control points (2..16 interleaved elements). */
export const MAX_POINTS = 8;

/** Clamp a control point to the firmware's accepted domain. */
export function clampPoint(p: CurvePoint): CurvePoint {
  return {
    speed: Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(p.speed) || 0)),
    factor: Math.min(
      FACTOR_MAX,
      Math.max(FACTOR_MIN, Math.round(p.factor) || FACTOR_MIN),
    ),
  };
}

/** Decode the interleaved wire format into control-point pairs. A trailing
 * odd element (protocol violation) is ignored, matching the firmware's
 * sanitizer. */
export function toPairs(points: number[]): CurvePoint[] {
  const pairs: CurvePoint[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) {
    pairs.push({ speed: points[i], factor: points[i + 1] });
  }
  return pairs;
}

/** Encode control-point pairs into the interleaved wire format. Values are
 * clamped to the firmware domain so out-of-range UI state can never produce
 * an invalid sint32 at the protobuf layer. */
export function toInterleaved(pairs: CurvePoint[]): number[] {
  return pairs.flatMap((p) => {
    const c = clampPoint(p);
    return [c.speed, c.factor];
  });
}
