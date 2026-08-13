/**
 * Firmware backport serializers.
 *
 * The fixtures under fixtures/ are verbatim copies of
 * nat-chan/zmk-keyboard-torabo-tsuki-lp (master): config/keymap.keymap,
 * config/keymap.json and the left shield overlay — the real files the
 * exporter rewrites.
 */
import { readFileSync } from "fs";
import { join } from "path";
import type { Keymap } from "@zmkfirmware/zmk-studio-ts-client/keymap";
import type { BehaviorDefinition } from "../../hooks/useKeymapSource";
import {
  buildBehaviorIdIndex,
  parseZmkBinding,
  resolvePresetBinding,
  serializeZmkBinding,
} from "../keymapPreset";
import {
  FirmwareFormatError,
  buildBehaviorTypeIndex,
  deriveGridRowLengths,
  deviceBindingToParsed,
  layerNodeName,
  renderKeymapJson,
  renderKeymapKeymap,
  replaceDefaultCurve,
  serializeDeviceKeymap,
} from "../firmwareExport";
import { KEYMAP_PRESETS } from "../../presets";

const FIXTURES = join(__dirname, "fixtures");
const KEYMAP_KEYMAP = readFileSync(join(FIXTURES, "keymap.keymap"), "utf8");
const KEYMAP_JSON = readFileSync(join(FIXTURES, "keymap.json"), "utf8");
const OVERLAY = readFileSync(
  join(FIXTURES, "torabo_tsuki_lp_left.overlay"),
  "utf8",
);

/** The bundled preset is a verbatim copy of the fixture repo's keymap.json. */
const PRESET = KEYMAP_PRESETS[0].keymap;

function behavior(id: number, displayName: string): BehaviorDefinition {
  return { id, displayName, metadata: [] };
}

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

/** Build the device-side Keymap that corresponds to the bundled preset, by
 * resolving every preset binding exactly like the preset-apply flow does. */
function presetAsDeviceKeymap(
  behaviors: Map<number, BehaviorDefinition>,
): Keymap {
  const behaviorIds = buildBehaviorIdIndex(behaviors);
  const layerIds = PRESET.layers.map((_, i) => i + 100);
  return {
    layers: PRESET.layers.map((bindings, layerIndex) => ({
      id: layerIds[layerIndex],
      name: PRESET.layer_names[layerIndex],
      bindings: bindings.map((text) => {
        const parsed = parseZmkBinding(text);
        if (!parsed) throw new Error(`fixture binding does not parse: ${text}`);
        const resolved = resolvePresetBinding(parsed, behaviorIds, layerIds);
        if (!resolved.ok) throw new Error(`unresolvable binding: ${text}`);
        return resolved.binding;
      }),
    })),
    availableLayers: 0,
    maxLayerNameLength: 20,
  };
}

describe("parse -> serialize round trip", () => {
  it("is the identity over every binding of the bundled preset", () => {
    for (const preset of KEYMAP_PRESETS) {
      for (const layer of preset.keymap.layers) {
        for (const text of layer) {
          const parsed = parseZmkBinding(text);
          expect(parsed).not.toBeNull();
          expect(serializeZmkBinding(parsed!)).toBe(text);
        }
      }
    }
  });

  it("returns null for usages without a plain ZMK spelling", () => {
    // Implicit-modifier bits (LS(...)-style) cannot be spelled as a name.
    expect(serializeZmkBinding({ type: "kp", usage: 0x02070004 })).toBeNull();
    // Consumer-page usage.
    expect(serializeZmkBinding({ type: "kp", usage: 0x0c00e9 })).toBeNull();
    // Combined mouse-button mask.
    expect(serializeZmkBinding({ type: "mkp", buttons: 3 })).toBeNull();
  });
});

describe("serializeDeviceKeymap", () => {
  it("reproduces the preset's binding strings and layer names exactly", () => {
    const behaviors = fullBehaviors();
    const keymap = presetAsDeviceKeymap(behaviors);
    const serialized = serializeDeviceKeymap(keymap, behaviors);
    expect(serialized.layerNames).toEqual(PRESET.layer_names);
    expect(serialized.layers).toEqual(PRESET.layers);
    expect(serialized.warnings).toEqual([]);
  });

  it("serializes &bt bindings (backport of Studio-assigned BT keys)", () => {
    const behaviors = fullBehaviors();
    behaviors.set(50, behavior(50, "Bluetooth"));
    const keymap = presetAsDeviceKeymap(behaviors);
    keymap.layers[0].bindings[0] = { behaviorId: 50, param1: 3, param2: 1 };
    keymap.layers[0].bindings[1] = { behaviorId: 50, param1: 5, param2: 0 };
    const serialized = serializeDeviceKeymap(keymap, behaviors);
    expect(serialized.layers[0][0]).toBe("&bt BT_SEL 1");
    expect(serialized.layers[0][1]).toBe("&bt BT_DISC 0");
    expect(serialized.warnings).toEqual([]);
  });

  it("exports unserializable bindings as &trans and reports them", () => {
    const behaviors = fullBehaviors();
    behaviors.set(60, behavior(60, "Macro"));
    const keymap = presetAsDeviceKeymap(behaviors);
    keymap.layers[0].bindings[0] = { behaviorId: 60, param1: 0, param2: 0 };
    const serialized = serializeDeviceKeymap(keymap, behaviors);
    expect(serialized.layers[0][0]).toBe("&trans");
    expect(serialized.warnings).toEqual([
      {
        layerIndex: 0,
        layerName: "default",
        keyPosition: 0,
        binding: "Macro (0, 0)",
      },
    ]);
  });

  it("maps &lt through layer ids, not indices", () => {
    const behaviors = fullBehaviors();
    const typeIndex = buildBehaviorTypeIndex(behaviors);
    const layerIndexById = new Map([[42, 3]]);
    const parsed = deviceBindingToParsed(
      { behaviorId: 29, param1: 42, param2: 0x070034 },
      typeIndex,
      layerIndexById,
    );
    expect(parsed).toEqual({ type: "lt", layerIndex: 3, usage: 0x070034 });
    expect(serializeZmkBinding(parsed!)).toBe("&lt 3 SQT");
  });
});

describe("renderKeymapKeymap", () => {
  const serialized = { layerNames: PRESET.layer_names, layers: PRESET.layers };

  it("derives the grid shape from the existing file", () => {
    expect(deriveGridRowLengths(KEYMAP_KEYMAP)).toEqual([12, 12, 14, 14, 14]);
  });

  it("preserves everything outside the layer nodes byte-for-byte", () => {
    const output = renderKeymapKeymap(KEYMAP_KEYMAP, serialized);
    const prefixEnd = KEYMAP_KEYMAP.indexOf("        default_layer {");
    const suffixStart = KEYMAP_KEYMAP.lastIndexOf("\n\n    };");
    expect(prefixEnd).toBeGreaterThan(0);
    expect(output.startsWith(KEYMAP_KEYMAP.slice(0, prefixEnd))).toBe(true);
    expect(output.endsWith(KEYMAP_KEYMAP.slice(suffixStart))).toBe(true);
    // Includes and the combos block survive untouched.
    expect(output).toContain("#include <dt-bindings/zmk/keys.h>");
    expect(output).toContain("bt_clear {");
    expect(output).toContain("key-positions = <28 29>;");
  });

  it("reproduces the existing column-aligned grid for unchanged layers", () => {
    const output = renderKeymapKeymap(KEYMAP_KEYMAP, serialized);
    // The uniformly-aligned layers of the source file must round-trip
    // byte-for-byte (layer 0 has a two-space alignment quirk in the
    // original, so it is normalized rather than identical).
    const block = (content: string, node: string) => {
      const start = content.indexOf(`        ${node} {`);
      const end = content.indexOf("};", start);
      return content.slice(start, end);
    };
    for (const node of ["layer_mouse", "layer_fn", "layer_scroll"]) {
      expect(block(output, node)).toBe(block(KEYMAP_KEYMAP, node));
    }
    // And the regenerated file still parses to the same grid shape.
    expect(deriveGridRowLengths(output)).toEqual([12, 12, 14, 14, 14]);
  });

  it("replaces bindings and renames layer nodes", () => {
    const changed = {
      layerNames: ["default", "mouse2", "fn", "scroll"],
      layers: PRESET.layers.map((layer, i) =>
        i === 0 ? ["&kp TAB", ...layer.slice(1)] : layer,
      ),
    };
    const output = renderKeymapKeymap(KEYMAP_KEYMAP, changed);
    expect(output).toContain("layer_mouse2 {");
    expect(output).not.toContain("layer_mouse {");
    const defaultBlock = output.slice(
      output.indexOf("default_layer {"),
      output.indexOf("layer_mouse2 {"),
    );
    expect(defaultBlock).toMatch(/&kp TAB\s+&kp N1/);
    expect(defaultBlock).not.toContain("&kp ESC");
  });

  it("throws a typed error when the key count does not match the grid", () => {
    const short = {
      layerNames: ["default"],
      layers: [PRESET.layers[0].slice(0, 10)],
    };
    expect(() => renderKeymapKeymap(KEYMAP_KEYMAP, short)).toThrow(
      FirmwareFormatError,
    );
  });
});

describe("layerNodeName", () => {
  it("follows the source file's naming convention", () => {
    expect(layerNodeName("default", 0)).toBe("default_layer");
    expect(layerNodeName("mouse", 1)).toBe("layer_mouse");
    expect(layerNodeName("layer_fn", 2)).toBe("layer_fn");
    expect(layerNodeName("my scroll!", 3)).toBe("layer_my_scroll_");
  });
});

describe("renderKeymapJson", () => {
  const rowLengths = deriveGridRowLengths(KEYMAP_KEYMAP);
  const serialized = { layerNames: PRESET.layer_names, layers: PRESET.layers };

  it("keeps non-layer fields and stays parseable", () => {
    const output = renderKeymapJson(KEYMAP_JSON, serialized, rowLengths);
    const parsed = JSON.parse(output);
    expect(parsed.keyboard).toBe("torabo_tsuki_lp");
    expect(parsed.keymap).toBe("torabo_tsuki_lp");
    expect(parsed.layout).toBe("LAYOUT");
    expect(parsed.layer_names).toEqual(PRESET.layer_names);
    expect(parsed.layers).toEqual(PRESET.layers);
  });

  it("reproduces the existing aligned-grid formatting for unchanged layers", () => {
    const output = renderKeymapJson(KEYMAP_JSON, serialized, rowLengths);
    // The "mouse" and "scroll" layers are uniformly aligned in the source
    // file, so their rendering must match byte-for-byte.
    const mouseRows = KEYMAP_JSON.split("\n").slice(18, 23).join("\n");
    expect(mouseRows).toContain('"&mkp LCLK"');
    expect(output).toContain(mouseRows);
    // Scalar header fields keep their formatting too.
    expect(output).toContain('  "keyboard": "torabo_tsuki_lp"');
    expect(output).toContain('  "layer_names": [\n    "default",');
  });

  it("updates layer names and bindings", () => {
    const changed = {
      layerNames: ["base", "mouse", "fn", "scroll"],
      layers: PRESET.layers.map((layer, i) =>
        i === 0 ? ["&kp GRAVE", ...layer.slice(1)] : layer,
      ),
    };
    const output = renderKeymapJson(KEYMAP_JSON, changed, rowLengths);
    const parsed = JSON.parse(output);
    expect(parsed.layer_names[0]).toBe("base");
    expect(parsed.layers[0][0]).toBe("&kp GRAVE");
  });
});

describe("replaceDefaultCurve", () => {
  it("replaces only the matching instance's curve", () => {
    const output = replaceDefaultCurve(
      OVERLAY,
      "pointer",
      [0, 500, 2000, 1500],
    );
    expect(output).toContain("default-curve = <0 500 2000 1500>;");
    // The scroll node keeps its original curve, and the rest of the overlay
    // is untouched.
    expect(output).toContain("default-curve = <0 1000 1500 1000 6000 3000>;");
    expect(output).not.toContain("default-curve = <0 300 1500 1000 6000 800>;");
    const expected = OVERLAY.replace(
      "default-curve = <0 300 1500 1000 6000 800>;",
      "default-curve = <0 500 2000 1500>;",
    );
    expect(output).toBe(expected);
  });

  it("replaces both instances independently", () => {
    let output = replaceDefaultCurve(OVERLAY, "pointer", [1, 2]);
    output = replaceDefaultCurve(output, "scroll", [3, 4]);
    expect(output).toContain(
      'instance-id = "pointer";\n        default-curve = <1 2>;',
    );
    expect(output).toContain(
      'instance-id = "scroll";\n        default-curve = <3 4>;',
    );
  });

  it("throws a typed error for an unknown instance", () => {
    expect(() => replaceDefaultCurve(OVERLAY, "nope", [1, 2])).toThrow(
      FirmwareFormatError,
    );
  });
});
