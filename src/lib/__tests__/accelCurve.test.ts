import {
  FACTOR_MAX,
  FACTOR_MIN,
  MAX_POINTS,
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
