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
/** Firmware accepts 1..8 control points (2..16 interleaved elements). */
export const MAX_POINTS = 8;

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

/** Encode control-point pairs into the interleaved wire format. */
export function toInterleaved(pairs: CurvePoint[]): number[] {
  return pairs.flatMap((p) => [p.speed, p.factor]);
}
