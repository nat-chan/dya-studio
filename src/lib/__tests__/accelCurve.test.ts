import {
  FACTOR_MAX,
  FACTOR_MIN,
  MAX_POINTS,
  SPEED_MAX,
  clampPoint,
  toInterleaved,
  toPairs,
} from "../accelCurve";

describe("accelCurve", () => {
  describe("toPairs", () => {
    it("should decode an interleaved list into speed/factor pairs", () => {
      expect(toPairs([0, 1000, 1000, 3000])).toEqual([
        { speed: 0, factor: 1000 },
        { speed: 1000, factor: 3000 },
      ]);
    });

    it("should return an empty list for an empty input", () => {
      expect(toPairs([])).toEqual([]);
    });

    it("should ignore a trailing odd element", () => {
      expect(toPairs([0, 1000, 500])).toEqual([{ speed: 0, factor: 1000 }]);
    });
  });

  describe("toInterleaved", () => {
    it("should encode pairs back into the interleaved wire format", () => {
      expect(
        toInterleaved([
          { speed: 0, factor: 1000 },
          { speed: 2000, factor: 3500 },
        ]),
      ).toEqual([0, 1000, 2000, 3500]);
    });

    it("should round-trip with toPairs", () => {
      const points = [0, 1000, 500, 1500, 3000, 20000];
      expect(toInterleaved(toPairs(points))).toEqual(points);
    });
  });

  describe("constants", () => {
    it("should match the firmware's limits", () => {
      expect(FACTOR_MIN).toBe(100);
      expect(FACTOR_MAX).toBe(20000);
      expect(MAX_POINTS).toBe(8);
    });
  });
});

describe("clampPoint / encode clamping (int32 overflow regression)", () => {
  it("clamps runaway speed values to SPEED_MAX before encoding", () => {
    // Regression: axis auto-scale let dragged speeds grow past int32
    // (e.g. 8711941592973) and the protobuf encoder threw "invalid int32".
    const points = toInterleaved([{ speed: 8711941592973, factor: 1000 }]);
    expect(points).toEqual([SPEED_MAX, 1000]);
  });

  it("clamps factors into the firmware range", () => {
    expect(clampPoint({ speed: -5, factor: 999999 })).toEqual({
      speed: 0,
      factor: FACTOR_MAX,
    });
    expect(clampPoint({ speed: 100.7, factor: 1 })).toEqual({
      speed: 101,
      factor: FACTOR_MIN,
    });
  });
});
