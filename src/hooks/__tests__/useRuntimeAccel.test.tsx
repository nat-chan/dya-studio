import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { ZMKAppContext } from "@cormoran/zmk-studio-react-hook";
import {
  useRuntimeAccel,
  RUNTIME_ACCEL_SUBSYSTEM_IDENTIFIER,
} from "../useRuntimeAccel";
import {
  Request,
  Response,
} from "../../proto/nat-chan/runtime-accel/runtime_accel";

const mockCallRPC = jest.fn();

jest.mock("@cormoran/zmk-studio-react-hook", () => {
  const actual = jest.requireActual("@cormoran/zmk-studio-react-hook");
  const {
    createUseCustomSubsystemMock,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
  } = require("../testUtils/mockUseCustomSubsystem");
  const ZMKCustomSubsystem = jest.fn().mockImplementation(() => ({
    callRPC: mockCallRPC,
  }));
  return {
    ...actual,
    ZMKCustomSubsystem,
    useCustomSubsystem: createUseCustomSubsystemMock(
      actual.ZMKAppContext,
      ZMKCustomSubsystem,
    ),
  };
});

function createWrapper() {
  const zmkAppValue = {
    state: { connection: {}, customSubsystems: [] },
    findSubsystem: () => ({
      index: 17,
      identifier: RUNTIME_ACCEL_SUBSYSTEM_IDENTIFIER,
    }),
    onNotification: () => () => {},
  };
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <ZMKAppContext.Provider value={zmkAppValue as never}>
        {children}
      </ZMKAppContext.Provider>
    );
  };
}

function encodeResponse(response: Parameters<typeof Response.create>[0]) {
  return Response.encode(Response.create(response)).finish();
}

/** In-memory fake firmware mirroring the RPC surface of the module. */
function mockFirmware(initialCurves: Record<string, number[]>) {
  const curves = new Map(Object.entries(initialCurves));
  const setCurveRequests: Array<{
    instanceId: string;
    points: number[];
    persist: boolean;
  }> = [];
  mockCallRPC.mockImplementation(async (payload: Uint8Array) => {
    const req = Request.decode(payload);
    if (req.listInstances !== undefined) {
      return encodeResponse({ instances: { ids: Array.from(curves.keys()) } });
    }
    if (req.getCurve !== undefined) {
      const points = curves.get(req.getCurve.instanceId);
      return points
        ? encodeResponse({
            curve: { instanceId: req.getCurve.instanceId, points },
          })
        : encodeResponse({ error: { message: "Unknown instance id" } });
    }
    if (req.setCurve !== undefined) {
      const { instanceId, points, persist } = req.setCurve;
      if (!curves.has(instanceId)) {
        return encodeResponse({ error: { message: "Unknown instance id" } });
      }
      setCurveRequests.push({ instanceId, points, persist });
      // Firmware sanitizes on apply: clamp factors to 100..20000.
      const sanitized = points.map((v, i) =>
        i % 2 === 1 ? Math.min(20000, Math.max(100, v)) : v,
      );
      curves.set(instanceId, sanitized);
      return encodeResponse({ ack: {} });
    }
    return encodeResponse({ error: { message: "Unsupported" } });
  });
  return { curves, setCurveRequests };
}

describe("useRuntimeAccel", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("lists instances and loads the first curve on mount", async () => {
    mockFirmware({
      pointer: [0, 1000, 1000, 3000],
      scroll: [0, 1000, 3000, 2000],
    });
    const { result } = renderHook(() => useRuntimeAccel(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.instances).toEqual(["pointer", "scroll"]);
    });
    expect(result.current.selectedId).toBe("pointer");
    expect(result.current.pairs).toEqual([
      { speed: 0, factor: 1000 },
      { speed: 1000, factor: 3000 },
    ]);
  });

  it("switches curves when another instance is selected", async () => {
    mockFirmware({
      pointer: [0, 1000],
      scroll: [0, 1000, 3000, 2000],
    });
    const { result } = renderHook(() => useRuntimeAccel(), {
      wrapper: createWrapper(),
    });
    await waitFor(() => {
      expect(result.current.instances).not.toBeNull();
    });

    await act(async () => {
      await result.current.selectInstance("scroll");
    });
    expect(result.current.selectedId).toBe("scroll");
    expect(result.current.pairs).toEqual([
      { speed: 0, factor: 1000 },
      { speed: 3000, factor: 2000 },
    ]);
  });

  it("sends setCurve with the persist flag and reloads the sanitized curve", async () => {
    const firmware = mockFirmware({ pointer: [0, 1000] });
    const { result } = renderHook(() => useRuntimeAccel(), {
      wrapper: createWrapper(),
    });
    await waitFor(() => {
      expect(result.current.pairs.length).toBe(1);
    });

    act(() => {
      result.current.editPairs(() => [{ speed: 0, factor: 20000 }]);
    });
    await act(async () => {
      await result.current.setCurve(false);
    });
    expect(firmware.setCurveRequests).toEqual([
      { instanceId: "pointer", points: [0, 20000], persist: false },
    ]);
    expect(result.current.lastAction).toBe("applied");
    // Reloaded after apply: the firmware clamped the factor.
    expect(result.current.pairs).toEqual([{ speed: 0, factor: 20000 }]);

    await act(async () => {
      await result.current.setCurve(true);
    });
    expect(firmware.setCurveRequests[1]).toEqual({
      instanceId: "pointer",
      points: [0, 20000],
      persist: true,
    });
    expect(result.current.lastAction).toBe("saved");
  });

  it("tracks the loaded curve, dirty state, and revert", async () => {
    mockFirmware({ pointer: [0, 1000, 1000, 3000] });
    const { result } = renderHook(() => useRuntimeAccel(), {
      wrapper: createWrapper(),
    });
    await waitFor(() => {
      expect(result.current.pairs.length).toBe(2);
    });
    expect(result.current.isDirty).toBe(false);
    expect(result.current.loadedPairs).toEqual(result.current.pairs);

    act(() => {
      result.current.editPairs((prev) => [
        prev[0],
        { speed: 2000, factor: 3500 },
      ]);
    });
    expect(result.current.isDirty).toBe(true);
    // The ghost baseline is untouched by local edits.
    expect(result.current.loadedPairs).toEqual([
      { speed: 0, factor: 1000 },
      { speed: 1000, factor: 3000 },
    ]);

    act(() => {
      result.current.revert();
    });
    expect(result.current.isDirty).toBe(false);
    expect(result.current.pairs).toEqual([
      { speed: 0, factor: 1000 },
      { speed: 1000, factor: 3000 },
    ]);

    // Applying resets the baseline to the firmware's sanitized curve.
    act(() => {
      result.current.editPairs(() => [{ speed: 0, factor: 25000 }]);
    });
    await act(async () => {
      await result.current.setCurve(false);
    });
    expect(result.current.pairs).toEqual([{ speed: 0, factor: 20000 }]);
    expect(result.current.isDirty).toBe(false);
  });

  it("surfaces firmware errors", async () => {
    mockFirmware({});
    const { result } = renderHook(() => useRuntimeAccel(), {
      wrapper: createWrapper(),
    });
    await waitFor(() => {
      expect(result.current.instances).toEqual([]);
    });

    await act(async () => {
      await result.current.selectInstance("nope");
    });
    expect(result.current.error).toBe("Unknown instance id");
  });
});
