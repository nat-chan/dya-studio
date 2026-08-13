import {
  RuntimeAccelHandler,
  RUNTIME_ACCEL_IDENTIFIER,
  sanitizeCurvePoints,
} from "../demo-runtime-accel";

describe("demo-runtime-accel", () => {
  it("exposes the nat_chan__runtime_accel identifier", () => {
    expect(RUNTIME_ACCEL_IDENTIFIER).toBe("nat_chan__runtime_accel");
  });

  describe("sanitizeCurvePoints", () => {
    it("clamps factors to the firmware's 100..20000 range", () => {
      expect(sanitizeCurvePoints([0, 5, 1000, 99999])).toEqual([
        0, 100, 1000, 20000,
      ]);
    });

    it("sorts points by speed", () => {
      expect(sanitizeCurvePoints([2000, 3000, 0, 1000])).toEqual([
        0, 1000, 2000, 3000,
      ]);
    });

    it("drops a trailing odd element and caps at 8 points", () => {
      const many = Array.from({ length: 20 }, (_, i) => i * 100);
      expect(sanitizeCurvePoints(many).length).toBe(16);
      expect(sanitizeCurvePoints([0, 1000, 500])).toEqual([0, 1000]);
    });
  });

  describe("RuntimeAccelHandler", () => {
    it("lists instances and serves their curves", () => {
      const handler = new RuntimeAccelHandler();
      const list = handler.process({ listInstances: {} });
      expect(list.instances?.ids).toEqual(["pointer", "scroll"]);

      const curve = handler.process({ getCurve: { instanceId: "pointer" } });
      expect(curve.curve?.instanceId).toBe("pointer");
      expect(curve.curve?.points.length).toBeGreaterThanOrEqual(2);
    });

    it("stores a sanitized curve on setCurve and acks", () => {
      const handler = new RuntimeAccelHandler();
      const ack = handler.process({
        setCurve: {
          instanceId: "pointer",
          points: [3000, 99999, 0, 1000],
          persist: false,
        },
      });
      expect(ack.ack).toBeDefined();

      const curve = handler.process({ getCurve: { instanceId: "pointer" } });
      expect(curve.curve?.points).toEqual([0, 1000, 3000, 20000]);
    });

    it("returns an error for unknown instance ids", () => {
      const handler = new RuntimeAccelHandler();
      expect(
        handler.process({ getCurve: { instanceId: "nope" } }).error,
      ).toBeDefined();
      expect(
        handler.process({
          setCurve: { instanceId: "nope", points: [0, 1000], persist: true },
        }).error,
      ).toBeDefined();
    });
  });
});
