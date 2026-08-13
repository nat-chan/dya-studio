import type { Keymap } from "@zmkfirmware/zmk-studio-ts-client/keymap";
import type { BehaviorDefinition } from "../../hooks/useKeymapSource";
import {
  buildBehaviorIdIndex,
  computePresetDiff,
  parseZmkBinding,
  resolvePresetBinding,
  zmkKeycodeToUsage,
  type PresetKeymapJson,
  serializeZmkBinding,
} from "../keymapPreset";
import { KEYMAP_PRESETS } from "../../presets";

function behavior(id: number, displayName: string): BehaviorDefinition {
  return { id, displayName, metadata: [] };
}

/** Device behavior list mirroring the demo keyboard's naming. */
function fullBehaviors(): Map<number, BehaviorDefinition> {
  return new Map(
    [
      behavior(10, "Key Press"),
      behavior(29, "Layer-Tap"),
      behavior(34, "Mod-Tap"),
      behavior(3, "Mouse Key Press"),
      behavior(35, "Transparent"),
      behavior(36, "None"),
    ].map((b) => [b.id, b]),
  );
}

const KP = 0x070000;

describe("zmkKeycodeToUsage", () => {
  it("maps canonical names and aliases to full HID usages", () => {
    expect(zmkKeycodeToUsage("A")).toBe(KP | 0x04);
    expect(zmkKeycodeToUsage("ESC")).toBe(KP | 0x29);
    expect(zmkKeycodeToUsage("N1")).toBe(KP | 0x1e);
    expect(zmkKeycodeToUsage("N0")).toBe(KP | 0x27);
    expect(zmkKeycodeToUsage("SQT")).toBe(KP | 0x34);
    expect(zmkKeycodeToUsage("SINGLE_QUOTE")).toBe(KP | 0x34);
    expect(zmkKeycodeToUsage("NUHS")).toBe(KP | 0x32);
    expect(zmkKeycodeToUsage("INTERNATIONAL_1")).toBe(KP | 0x87);
    expect(zmkKeycodeToUsage("INTERNATIONAL_3")).toBe(KP | 0x89);
    expect(zmkKeycodeToUsage("INT5")).toBe(KP | 0x8b);
    expect(zmkKeycodeToUsage("F12")).toBe(KP | 0x45);
    expect(zmkKeycodeToUsage("RIGHT_SHIFT")).toBe(KP | 0xe5);
    expect(zmkKeycodeToUsage("NO_SUCH_KEY")).toBeNull();
  });
});

describe("parseZmkBinding", () => {
  it("parses the supported behavior forms", () => {
    expect(parseZmkBinding("&kp ESC")).toEqual({
      type: "kp",
      usage: KP | 0x29,
    });
    expect(parseZmkBinding("&lt 3 SQT")).toEqual({
      type: "lt",
      layerIndex: 3,
      usage: KP | 0x34,
    });
    expect(parseZmkBinding("&mt RIGHT_SHIFT FSLH")).toEqual({
      type: "mt",
      modUsage: KP | 0xe5,
      usage: KP | 0x38,
    });
    expect(parseZmkBinding("&mkp LCLK")).toEqual({ type: "mkp", buttons: 1 });
    expect(parseZmkBinding("&mkp RCLK")).toEqual({ type: "mkp", buttons: 2 });
    expect(parseZmkBinding("&trans")).toEqual({ type: "trans" });
    expect(parseZmkBinding("&none")).toEqual({ type: "none" });
  });

  it("returns null for unknown behaviors, keycodes, or malformed params", () => {
    expect(parseZmkBinding("&kp NOPE")).toBeNull();
    expect(parseZmkBinding("&kp")).toBeNull();
    expect(parseZmkBinding("&lt x SQT")).toBeNull();
    expect(parseZmkBinding("&mkp SIDEWAYS")).toBeNull();
  });
});

describe("resolvePresetBinding", () => {
  const behaviors = fullBehaviors();
  const ids = buildBehaviorIdIndex(behaviors);

  it("resolves behaviors by display-name variants to device ids", () => {
    expect(ids.get("kp")).toBe(10);
    expect(ids.get("lt")).toBe(29);
    expect(ids.get("mt")).toBe(34);
    expect(ids.get("mkp")).toBe(3);
    expect(ids.get("trans")).toBe(35);
    expect(ids.get("none")).toBe(36);
  });

  it("encodes params in ZMK Studio conventions", () => {
    expect(
      resolvePresetBinding({ type: "kp", usage: KP | 0x04 }, ids, [7]),
    ).toEqual({
      ok: true,
      binding: { behaviorId: 10, param1: KP | 0x04, param2: 0 },
    });
    // &lt: param1 = device layer id (not the preset index), param2 = keycode.
    expect(
      resolvePresetBinding(
        { type: "lt", layerIndex: 0, usage: KP | 0x2c },
        ids,
        [42],
      ),
    ).toEqual({
      ok: true,
      binding: { behaviorId: 29, param1: 42, param2: KP | 0x2c },
    });
    expect(
      resolvePresetBinding(
        { type: "mt", modUsage: KP | 0xe5, usage: KP | 0x38 },
        ids,
        [],
      ),
    ).toEqual({
      ok: true,
      binding: { behaviorId: 34, param1: KP | 0xe5, param2: KP | 0x38 },
    });
    expect(resolvePresetBinding({ type: "mkp", buttons: 2 }, ids, [])).toEqual({
      ok: true,
      binding: { behaviorId: 3, param1: 2, param2: 0 },
    });
  });

  it("reports a missing behavior instead of failing", () => {
    const noMouse = new Map(fullBehaviors());
    noMouse.delete(3);
    const partialIds = buildBehaviorIdIndex(noMouse);
    expect(
      resolvePresetBinding({ type: "mkp", buttons: 1 }, partialIds, []),
    ).toEqual({ ok: false, reason: "behavior-missing" });
  });

  it("reports a missing layer for &lt into a nonexistent layer", () => {
    expect(
      resolvePresetBinding(
        { type: "lt", layerIndex: 5, usage: KP | 0x2c },
        ids,
        [0, 1],
      ),
    ).toEqual({ ok: false, reason: "layer-missing" });
  });
});

describe("computePresetDiff", () => {
  const preset: PresetKeymapJson = {
    keyboard: "test",
    layer_names: ["base", "extra"],
    layers: [
      ["&kp A", "&mkp LCLK", "&trans"],
      ["&trans", "&lt 1 SPACE", "&none"],
    ],
  };

  function deviceKeymap(): Keymap {
    return {
      layers: [
        {
          id: 100,
          name: "base",
          bindings: [
            { behaviorId: 10, param1: KP | 0x04, param2: 0 }, // == &kp A
            { behaviorId: 10, param1: KP | 0x05, param2: 0 }, // &kp B
            { behaviorId: 35, param1: 0, param2: 0 }, // == &trans
          ],
        },
      ],
      availableLayers: 4,
      maxLayerNameLength: 16,
    };
  }

  it("classifies same/changed bindings and layer additions", () => {
    const diff = computePresetDiff(preset, deviceKeymap(), fullBehaviors());
    expect(diff.layersToAdd).toBe(1);
    expect(diff.canAddLayers).toBe(true);
    const base = diff.layers[0];
    expect(base.layerId).toBe(100);
    expect(base.entries.map((e) => e.status)).toEqual([
      "same",
      "change",
      "same",
    ]);
    // The new layer's non-trans bindings are changes; &lt targeting the
    // to-be-added layer stays appliable (placeholder id resolved at apply).
    const extra = diff.layers[1];
    expect(extra.layerId).toBeNull();
    expect(extra.entries.map((e) => e.status)).toEqual([
      "change",
      "change",
      "change",
    ]);
    expect(diff.counts).toEqual({ same: 2, change: 4, unappliable: 0 });
  });

  it("marks bindings with missing behaviors as unappliable, not the whole diff", () => {
    const noMouse = fullBehaviors();
    noMouse.delete(3);
    const diff = computePresetDiff(preset, deviceKeymap(), noMouse);
    expect(diff.layers[0].entries[1].status).toBe("unappliable");
    expect(diff.layers[0].entries[1].reason).toBe("behavior-missing");
    // Everything else still diffs normally.
    expect(diff.layers[0].entries[0].status).toBe("same");
  });

  it("marks key positions beyond the device's key count as unappliable", () => {
    const keymap = deviceKeymap();
    keymap.layers[0].bindings = keymap.layers[0].bindings.slice(0, 2);
    const diff = computePresetDiff(preset, keymap, fullBehaviors());
    expect(diff.layers[0].entries[2].status).toBe("unappliable");
    expect(diff.layers[0].entries[2].reason).toBe("position-out-of-range");
  });

  it("marks new-layer bindings unappliable when no layer slots are free", () => {
    const keymap = deviceKeymap();
    keymap.availableLayers = 0;
    const diff = computePresetDiff(preset, keymap, fullBehaviors());
    expect(diff.canAddLayers).toBe(false);
    expect(
      diff.layers[1].entries.every((e) => e.status === "unappliable"),
    ).toBe(true);
  });

  it("detects layer renames", () => {
    const keymap = deviceKeymap();
    keymap.layers[0].name = "Layer 0";
    const diff = computePresetDiff(preset, keymap, fullBehaviors());
    expect(diff.layers[0].nameChanged).toBe(true);
    expect(diff.layers[0].presetName).toBe("base");
  });
});

describe("bundled presets", () => {
  it("every binding in every bundled preset parses", () => {
    for (const preset of KEYMAP_PRESETS) {
      expect(preset.keymap.layers.length).toBe(
        preset.keymap.layer_names.length,
      );
      for (const layer of preset.keymap.layers) {
        for (const text of layer) {
          expect({ text, parsed: parseZmkBinding(text) }).toEqual({
            text,
            parsed: expect.anything(),
          });
        }
      }
    }
  });

  it("the Torabo-Tsuki preset has 4 layers of 66 keys", () => {
    const preset = KEYMAP_PRESETS.find((p) => p.id === "torabo-tsuki-keyball");
    expect(preset).toBeDefined();
    expect(preset?.keymap.layer_names).toEqual([
      "default",
      "mouse",
      "fn",
      "scroll",
    ]);
    for (const layer of preset?.keymap.layers ?? []) {
      expect(layer.length).toBe(66);
    }
  });
});

describe("&bt / &out round-trip (backport support)", () => {
  const cases = [
    "&bt BT_CLR",
    "&bt BT_NXT",
    "&bt BT_PRV",
    "&bt BT_SEL 0",
    "&bt BT_SEL 1",
    "&bt BT_CLR_ALL",
    "&bt BT_DISC 0",
    "&out OUT_TOG",
    "&out OUT_USB",
    "&out OUT_BLE",
  ];
  it.each(cases)("parse→serialize identity: %s", (text) => {
    const parsed = parseZmkBinding(text);
    expect(parsed).not.toBeNull();
    expect(serializeZmkBinding(parsed!)).toBe(text);
  });

  it("maps BT_SEL/BT_DISC params as (command, arg)", () => {
    expect(parseZmkBinding("&bt BT_SEL 1")).toEqual({
      type: "bt",
      command: 3,
      arg: 1,
    });
    expect(parseZmkBinding("&bt BT_DISC 0")).toEqual({
      type: "bt",
      command: 5,
      arg: 0,
    });
  });

  it("rejects malformed bt bindings", () => {
    expect(parseZmkBinding("&bt BT_SEL")).toBeNull();
    expect(parseZmkBinding("&bt BT_CLR 1")).toBeNull();
    expect(parseZmkBinding("&bt UNKNOWN")).toBeNull();
  });
});
