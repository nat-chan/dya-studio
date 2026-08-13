/**
 * Built-in keymap presets: parse ZMK devicetree-style binding strings
 * ("&kp ESC", "&lt 3 SQT", "&mkp LCLK", ...), diff them against the keymap
 * currently loaded from the keyboard, and resolve them into the
 * `BehaviorBinding` (behaviorId/param1/param2) form the standard ZMK Studio
 * keymap RPCs expect.
 *
 * Presets are stored portably (behavior alias + keycode names), because
 * `behaviorId` is device-local: ids are resolved against the connected
 * keyboard's behavior list at diff/apply time. A binding whose behavior the
 * keyboard lacks is marked "unappliable" instead of failing the whole apply.
 */

import type {
  BehaviorBinding,
  Keymap,
} from "@zmkfirmware/zmk-studio-ts-client/keymap";
import type { BehaviorDefinition } from "../hooks/useKeymapSource";
import { getBehaviorMetadata } from "./behaviorMetadata";
import { HID_USAGE_PAGE_KEYBOARD, createHidUsage } from "./keycodes";

// ---------------------------------------------------------------------------
// Preset definition
// ---------------------------------------------------------------------------

/** Shape of a bundled preset keymap JSON (zmk keymap.json convention). */
export interface PresetKeymapJson {
  keyboard: string;
  layer_names: string[];
  /** One array of ZMK binding strings per layer, indexed by key position. */
  layers: string[][];
}

export interface KeymapPresetDefinition {
  /** Stable id (used for React keys, analytics). */
  id: string;
  /** Untranslated (English) preset name — pass through t(). */
  name: string;
  /** Untranslated (English) short description — pass through t(). */
  description: string;
  keymap: PresetKeymapJson;
}

// ---------------------------------------------------------------------------
// ZMK keycode names -> HID usage (keyboard page)
// ---------------------------------------------------------------------------

/**
 * Canonical ZMK keycode names and aliases -> HID keyboard-page usage code.
 * Subset of zmk/include/dt-bindings/zmk/keys.h sufficient for bundled
 * presets; extend as presets need more codes.
 */
const ZMK_KEYCODES: Record<string, number> = {
  // Letters
  ...Object.fromEntries(
    Array.from({ length: 26 }, (_, i) => [
      String.fromCharCode(65 + i),
      0x04 + i,
    ]),
  ),
  // Numbers (N1..N9, N0)
  ...Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [`N${i + 1}`, 0x1e + i]),
  ),
  N0: 0x27,
  NUMBER_1: 0x1e,
  NUMBER_2: 0x1f,
  NUMBER_3: 0x20,
  NUMBER_4: 0x21,
  NUMBER_5: 0x22,
  NUMBER_6: 0x23,
  NUMBER_7: 0x24,
  NUMBER_8: 0x25,
  NUMBER_9: 0x26,
  NUMBER_0: 0x27,
  // Control / whitespace
  ENTER: 0x28,
  RET: 0x28,
  RETURN: 0x28,
  ESC: 0x29,
  ESCAPE: 0x29,
  BSPC: 0x2a,
  BACKSPACE: 0x2a,
  TAB: 0x2b,
  SPACE: 0x2c,
  // Punctuation
  MINUS: 0x2d,
  EQUAL: 0x2e,
  LBKT: 0x2f,
  LEFT_BRACKET: 0x2f,
  RBKT: 0x30,
  RIGHT_BRACKET: 0x30,
  BSLH: 0x31,
  BACKSLASH: 0x31,
  NUHS: 0x32,
  NON_US_HASH: 0x32,
  SEMI: 0x33,
  SEMICOLON: 0x33,
  SQT: 0x34,
  SINGLE_QUOTE: 0x34,
  APOS: 0x34,
  APOSTROPHE: 0x34,
  GRAVE: 0x35,
  COMMA: 0x36,
  DOT: 0x37,
  PERIOD: 0x37,
  FSLH: 0x38,
  SLASH: 0x38,
  CAPS: 0x39,
  CAPSLOCK: 0x39,
  CLCK: 0x39,
  // Function keys
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, 0x3a + i]),
  ),
  // Navigation
  PSCRN: 0x46,
  PRINTSCREEN: 0x46,
  SLCK: 0x47,
  SCROLLLOCK: 0x47,
  PAUSE_BREAK: 0x48,
  INS: 0x49,
  INSERT: 0x49,
  HOME: 0x4a,
  PG_UP: 0x4b,
  PAGE_UP: 0x4b,
  DEL: 0x4c,
  DELETE: 0x4c,
  END: 0x4d,
  PG_DN: 0x4e,
  PAGE_DOWN: 0x4e,
  RIGHT: 0x4f,
  RIGHT_ARROW: 0x4f,
  LEFT: 0x50,
  LEFT_ARROW: 0x50,
  DOWN: 0x51,
  DOWN_ARROW: 0x51,
  UP: 0x52,
  UP_ARROW: 0x52,
  // Non-US / international
  NON_US_BSLH: 0x64,
  NON_US_BACKSLASH: 0x64,
  NUBS: 0x64,
  INT1: 0x87,
  INTERNATIONAL_1: 0x87,
  INT_RO: 0x87,
  INT2: 0x88,
  INTERNATIONAL_2: 0x88,
  INT_KANA: 0x88,
  INT3: 0x89,
  INTERNATIONAL_3: 0x89,
  INT_YEN: 0x89,
  INT4: 0x8a,
  INTERNATIONAL_4: 0x8a,
  INT_HENKAN: 0x8a,
  INT5: 0x8b,
  INTERNATIONAL_5: 0x8b,
  INT_MUHENKAN: 0x8b,
  LANG1: 0x90,
  LANG2: 0x91,
  // Modifiers
  LCTRL: 0xe0,
  LEFT_CONTROL: 0xe0,
  LSHFT: 0xe1,
  LSHIFT: 0xe1,
  LEFT_SHIFT: 0xe1,
  LALT: 0xe2,
  LEFT_ALT: 0xe2,
  LGUI: 0xe3,
  LEFT_GUI: 0xe3,
  LWIN: 0xe3,
  LCMD: 0xe3,
  RCTRL: 0xe4,
  RIGHT_CONTROL: 0xe4,
  RSHFT: 0xe5,
  RSHIFT: 0xe5,
  RIGHT_SHIFT: 0xe5,
  RALT: 0xe6,
  RIGHT_ALT: 0xe6,
  RGUI: 0xe7,
  RIGHT_GUI: 0xe7,
  RWIN: 0xe7,
  RCMD: 0xe7,
};

/** ZMK mouse button names -> `&mkp` param bitmask values. */
const ZMK_MOUSE_BUTTONS: Record<string, number> = {
  LCLK: 1,
  MB1: 1,
  RCLK: 2,
  MB2: 2,
  MCLK: 4,
  MB3: 4,
  MB4: 8,
  MB5: 16,
};

/** Resolve a ZMK keycode name to a full HID usage (page << 16 | code). */
export function zmkKeycodeToUsage(name: string): number | null {
  const code = ZMK_KEYCODES[name.toUpperCase()];
  if (code === undefined) return null;
  return createHidUsage(HID_USAGE_PAGE_KEYBOARD, code);
}

// ---------------------------------------------------------------------------
// Binding-string parsing
// ---------------------------------------------------------------------------

export type ParsedBinding =
  | { type: "kp"; usage: number }
  | { type: "lt"; layerIndex: number; usage: number }
  | { type: "mt"; modUsage: number; usage: number }
  | { type: "mkp"; buttons: number }
  | { type: "trans" }
  | { type: "none" };

/**
 * Parse one devicetree-style binding string. Returns null for anything not
 * understood (unknown behavior, unknown keycode, malformed params) — the
 * caller marks such entries unappliable.
 */
export function parseZmkBinding(text: string): ParsedBinding | null {
  const tokens = text.trim().split(/\s+/);
  const behavior = tokens[0];
  switch (behavior) {
    case "&trans":
      return tokens.length === 1 ? { type: "trans" } : null;
    case "&none":
      return tokens.length === 1 ? { type: "none" } : null;
    case "&kp": {
      if (tokens.length !== 2) return null;
      const usage = zmkKeycodeToUsage(tokens[1]);
      return usage === null ? null : { type: "kp", usage };
    }
    case "&lt": {
      if (tokens.length !== 3) return null;
      const layerIndex = Number.parseInt(tokens[1], 10);
      const usage = zmkKeycodeToUsage(tokens[2]);
      if (!Number.isInteger(layerIndex) || layerIndex < 0 || usage === null) {
        return null;
      }
      return { type: "lt", layerIndex, usage };
    }
    case "&mt": {
      if (tokens.length !== 3) return null;
      const modUsage = zmkKeycodeToUsage(tokens[1]);
      const usage = zmkKeycodeToUsage(tokens[2]);
      if (modUsage === null || usage === null) return null;
      return { type: "mt", modUsage, usage };
    }
    case "&mkp": {
      if (tokens.length !== 2) return null;
      const buttons = ZMK_MOUSE_BUTTONS[tokens[1].toUpperCase()];
      return buttons === undefined ? null : { type: "mkp", buttons };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Behavior resolution against the connected keyboard
// ---------------------------------------------------------------------------

/** Behavior alias (as used by getBehaviorMetadata) per parsed binding type. */
const BEHAVIOR_ALIAS: Record<ParsedBinding["type"], string> = {
  kp: "kp",
  lt: "lt",
  mt: "mt",
  mkp: "mkp",
  trans: "Trans",
  none: "None",
};

/**
 * Map of parsed-binding type -> device behaviorId, built from the connected
 * keyboard's behavior list by matching each device behavior's displayName
 * against the shared behavior-metadata variant table.
 */
export function buildBehaviorIdIndex(
  behaviors: Map<number, BehaviorDefinition>,
): Map<ParsedBinding["type"], number> {
  const index = new Map<ParsedBinding["type"], number>();
  for (const [type, alias] of Object.entries(BEHAVIOR_ALIAS) as Array<
    [ParsedBinding["type"], string]
  >) {
    const wanted = getBehaviorMetadata(alias);
    if (!wanted) continue;
    for (const behavior of behaviors.values()) {
      if (getBehaviorMetadata(behavior.displayName) === wanted) {
        index.set(type, behavior.id);
        break;
      }
    }
  }
  return index;
}

/**
 * Layer-id lookup used to resolve `&lt` targets: index = preset layer index,
 * value = device layer id, or null when that layer does not exist (yet).
 */
export type LayerIdByIndex = Array<number | null>;

export type PresetBindingResolution =
  | { ok: true; binding: BehaviorBinding }
  | { ok: false; reason: "behavior-missing" | "layer-missing" };

/** Resolve a parsed binding into device BehaviorBinding form. */
export function resolvePresetBinding(
  parsed: ParsedBinding,
  behaviorIds: Map<ParsedBinding["type"], number>,
  layerIdByIndex: LayerIdByIndex,
): PresetBindingResolution {
  const behaviorId = behaviorIds.get(parsed.type);
  if (behaviorId === undefined) {
    return { ok: false, reason: "behavior-missing" };
  }
  switch (parsed.type) {
    case "kp":
      return {
        ok: true,
        binding: { behaviorId, param1: parsed.usage, param2: 0 },
      };
    case "lt": {
      const layerId = layerIdByIndex[parsed.layerIndex];
      if (layerId === null || layerId === undefined) {
        return { ok: false, reason: "layer-missing" };
      }
      return {
        ok: true,
        binding: { behaviorId, param1: layerId, param2: parsed.usage },
      };
    }
    case "mt":
      return {
        ok: true,
        binding: { behaviorId, param1: parsed.modUsage, param2: parsed.usage },
      };
    case "mkp":
      return {
        ok: true,
        binding: { behaviorId, param1: parsed.buttons, param2: 0 },
      };
    case "trans":
    case "none":
      return { ok: true, binding: { behaviorId, param1: 0, param2: 0 } };
  }
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export type PresetEntryStatus = "same" | "change" | "unappliable";

export interface PresetDiffEntry {
  keyPosition: number;
  /** Binding currently on the keyboard, or null when the layer is new. */
  current: BehaviorBinding | null;
  /**
   * Resolved binding to write, or null when unappliable. An `&lt` into a
   * layer that will be added during apply carries the placeholder id -1 in
   * param1 — re-resolve via {@link resolvePresetBinding} with the final
   * layer ids (see `parsed`) before writing.
   */
  desired: BehaviorBinding | null;
  /** Parsed form, for re-resolution at apply time. */
  parsed?: ParsedBinding;
  /** Raw preset token, e.g. "&lt 3 SQT" — display fallback. */
  presetText: string;
  status: PresetEntryStatus;
  reason?:
    | "parse-error"
    | "behavior-missing"
    | "layer-missing"
    | "position-out-of-range";
}

export interface PresetDiffLayer {
  /** Index in the preset (and, for existing layers, in keymap.layers). */
  layerIndex: number;
  /** Device layer id, or null when the layer must be added first. */
  layerId: number | null;
  presetName: string;
  currentName: string | null;
  nameChanged: boolean;
  entries: PresetDiffEntry[];
}

export interface PresetDiff {
  layers: PresetDiffLayer[];
  /** Layers the preset needs beyond what the keymap currently has. */
  layersToAdd: number;
  /** Whether the keyboard has enough free layer slots for layersToAdd. */
  canAddLayers: boolean;
  counts: { same: number; change: number; unappliable: number };
}

/**
 * Compare a preset against the keymap currently loaded from the keyboard.
 *
 * Layer mapping is positional (preset layer i <-> keymap.layers[i]); extra
 * preset layers become additions when free slots exist. Key positions beyond
 * the device's key count are unappliable. Bindings whose behavior the
 * keyboard lacks are unappliable individually.
 */
export function computePresetDiff(
  preset: PresetKeymapJson,
  keymap: Keymap,
  behaviors: Map<number, BehaviorDefinition>,
): PresetDiff {
  const behaviorIds = buildBehaviorIdIndex(behaviors);
  const layersToAdd = Math.max(0, preset.layers.length - keymap.layers.length);
  const canAddLayers = layersToAdd <= keymap.availableLayers;
  const layerIdByIndex: LayerIdByIndex = preset.layers.map(
    (_, i) => keymap.layers[i]?.id ?? null,
  );
  // For diff purposes an &lt into a layer that will be added is resolvable
  // (its id becomes known during apply); represent it with a placeholder so
  // it compares as a change rather than unappliable — unless the keyboard
  // has no free slots, in which case the layer really is missing.
  const layerIdForDiff: LayerIdByIndex = layerIdByIndex.map((id, i) =>
    id !== null ? id : canAddLayers && i < preset.layers.length ? -1 : null,
  );

  const counts = { same: 0, change: 0, unappliable: 0 };
  const layers: PresetDiffLayer[] = preset.layers.map(
    (bindings, layerIndex) => {
      const deviceLayer = keymap.layers[layerIndex] ?? null;
      const layerExists = deviceLayer !== null;
      const deviceKeyCount = keymap.layers[0]?.bindings.length ?? 0;
      const entries: PresetDiffEntry[] = bindings.map((text, keyPosition) => {
        const current = deviceLayer?.bindings[keyPosition] ?? null;
        const base = { keyPosition, current, presetText: text };
        if (keyPosition >= deviceKeyCount) {
          counts.unappliable++;
          return {
            ...base,
            desired: null,
            status: "unappliable" as const,
            reason: "position-out-of-range" as const,
          };
        }
        const parsed = parseZmkBinding(text);
        if (!parsed) {
          counts.unappliable++;
          return {
            ...base,
            desired: null,
            status: "unappliable" as const,
            reason: "parse-error" as const,
          };
        }
        const resolved = resolvePresetBinding(
          parsed,
          behaviorIds,
          layerIdForDiff,
        );
        if (!resolved.ok) {
          counts.unappliable++;
          return {
            ...base,
            desired: null,
            status: "unappliable" as const,
            reason: resolved.reason,
          };
        }
        const isSame =
          layerExists &&
          current !== null &&
          current.behaviorId === resolved.binding.behaviorId &&
          current.param1 === resolved.binding.param1 &&
          current.param2 === resolved.binding.param2;
        if (isSame) {
          counts.same++;
        } else if (!layerExists && !canAddLayers) {
          counts.unappliable++;
          return {
            ...base,
            desired: null,
            status: "unappliable" as const,
            reason: "layer-missing" as const,
          };
        } else {
          counts.change++;
        }
        return {
          ...base,
          desired: resolved.binding,
          parsed,
          status: isSame ? ("same" as const) : ("change" as const),
        };
      });

      const presetName = preset.layer_names[layerIndex] ?? `L${layerIndex}`;
      const currentName = deviceLayer?.name ?? null;
      return {
        layerIndex,
        layerId: deviceLayer?.id ?? null,
        presetName,
        currentName,
        nameChanged: !layerExists || currentName !== presetName,
        entries,
      };
    },
  );

  return { layers, layersToAdd, canAddLayers, counts };
}
