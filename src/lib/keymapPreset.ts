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
import {
  HID_USAGE_PAGE_KEYBOARD,
  createHidUsage,
  getHidUsageCode,
  getHidUsagePage,
} from "./keycodes";

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
// ZMK keycode names <-> HID usage (keyboard page)
// ---------------------------------------------------------------------------

/**
 * One keycode: HID keyboard-page usage code plus its ZMK names, CANONICAL
 * name first. This list is the single source of truth for BOTH directions:
 * every listed name parses (name -> usage), and the canonical name is what
 * serialization emits (usage -> name), so a parse -> serialize round trip is
 * the identity on canonical spellings.
 *
 * Canonical spellings deliberately match the ones used in
 * nat-chan/zmk-keyboard-torabo-tsuki-lp's config/keymap.json (SEMI over
 * SEMICOLON, INTERNATIONAL_1 over INT1 but INT5 over INTERNATIONAL_5, ...) so
 * the firmware-backport export reproduces that repo's keymap verbatim; the
 * round trip over the bundled preset is unit-tested.
 */
type ZmkKeycodeDef = readonly [code: number, ...names: string[]];

const ZMK_KEYCODE_DEFS: readonly ZmkKeycodeDef[] = [
  // Letters
  ...Array.from(
    { length: 26 },
    (_, i) => [0x04 + i, String.fromCharCode(65 + i)] as const,
  ),
  // Numbers (N1..N9, N0)
  ...Array.from(
    { length: 9 },
    (_, i) => [0x1e + i, `N${i + 1}`, `NUMBER_${i + 1}`] as const,
  ),
  [0x27, "N0", "NUMBER_0"],
  // Control / whitespace
  [0x28, "ENTER", "RET", "RETURN"],
  [0x29, "ESC", "ESCAPE"],
  [0x2a, "BSPC", "BACKSPACE"],
  [0x2b, "TAB"],
  [0x2c, "SPACE"],
  // Punctuation
  [0x2d, "MINUS"],
  [0x2e, "EQUAL"],
  [0x2f, "LEFT_BRACKET", "LBKT"],
  [0x30, "RIGHT_BRACKET", "RBKT"],
  [0x31, "BSLH", "BACKSLASH"],
  [0x32, "NUHS", "NON_US_HASH"],
  [0x33, "SEMI", "SEMICOLON"],
  [0x34, "SQT", "SINGLE_QUOTE", "APOS", "APOSTROPHE"],
  [0x35, "GRAVE"],
  [0x36, "COMMA"],
  [0x37, "DOT", "PERIOD"],
  [0x38, "FSLH", "SLASH"],
  [0x39, "CAPS", "CAPSLOCK", "CLCK"],
  // Function keys
  ...Array.from({ length: 12 }, (_, i) => [0x3a + i, `F${i + 1}`] as const),
  // Navigation
  [0x46, "PRINTSCREEN", "PSCRN"],
  [0x47, "SLCK", "SCROLLLOCK"],
  [0x48, "PAUSE_BREAK"],
  [0x49, "INS", "INSERT"],
  [0x4a, "HOME"],
  [0x4b, "PG_UP", "PAGE_UP"],
  [0x4c, "DELETE", "DEL"],
  [0x4d, "END"],
  [0x4e, "PG_DN", "PAGE_DOWN"],
  [0x4f, "RIGHT_ARROW", "RIGHT"],
  [0x50, "LEFT_ARROW", "LEFT"],
  [0x51, "DOWN_ARROW", "DOWN"],
  [0x52, "UP_ARROW", "UP"],
  // Non-US / international
  [0x64, "NON_US_BSLH", "NON_US_BACKSLASH", "NUBS"],
  [0x87, "INTERNATIONAL_1", "INT1", "INT_RO"],
  [0x88, "INTERNATIONAL_2", "INT2", "INT_KANA"],
  [0x89, "INTERNATIONAL_3", "INT3", "INT_YEN"],
  [0x8a, "INTERNATIONAL_4", "INT4", "INT_HENKAN"],
  [0x8b, "INT5", "INTERNATIONAL_5", "INT_MUHENKAN"],
  [0x90, "LANG1"],
  [0x91, "LANG2"],
  // Modifiers
  [0xe0, "LCTRL", "LEFT_CONTROL"],
  [0xe1, "LSHFT", "LSHIFT", "LEFT_SHIFT"],
  [0xe2, "LALT", "LEFT_ALT"],
  [0xe3, "LGUI", "LEFT_GUI", "LWIN", "LCMD"],
  [0xe4, "RCTRL", "RIGHT_CONTROL"],
  [0xe5, "RIGHT_SHIFT", "RSHFT", "RSHIFT"],
  [0xe6, "RALT", "RIGHT_ALT"],
  [0xe7, "RGUI", "RIGHT_GUI", "RWIN", "RCMD"],
];

/** Every ZMK keycode name (canonical + aliases) -> HID keyboard-page code. */
const ZMK_KEYCODES: Record<string, number> = Object.fromEntries(
  ZMK_KEYCODE_DEFS.flatMap(([code, ...names]) =>
    names.map((name) => [name, code]),
  ),
);

/** HID keyboard-page code -> canonical ZMK keycode name. */
const ZMK_KEYCODE_CANONICAL_NAMES = new Map<number, string>(
  ZMK_KEYCODE_DEFS.map(([code, ...names]) => [code, names[0]]),
);

/**
 * ZMK mouse button: `&mkp` param bitmask value plus its names, canonical name
 * first. Single source of truth for both directions, like
 * {@link ZMK_KEYCODE_DEFS}.
 */
const ZMK_MOUSE_BUTTON_DEFS: readonly ZmkKeycodeDef[] = [
  [1, "LCLK", "MB1"],
  [2, "RCLK", "MB2"],
  [4, "MCLK", "MB3"],
  [8, "MB4"],
  [16, "MB5"],
];

/** Every ZMK mouse button name -> `&mkp` param bitmask value. */
const ZMK_MOUSE_BUTTONS: Record<string, number> = Object.fromEntries(
  ZMK_MOUSE_BUTTON_DEFS.flatMap(([mask, ...names]) =>
    names.map((name) => [name, mask]),
  ),
);

/** `&mkp` param bitmask value -> canonical ZMK mouse button name. */
const ZMK_MOUSE_BUTTON_CANONICAL_NAMES = new Map<number, string>(
  ZMK_MOUSE_BUTTON_DEFS.map(([mask, ...names]) => [mask, names[0]]),
);

/** Resolve a ZMK keycode name to a full HID usage (page << 16 | code). */
export function zmkKeycodeToUsage(name: string): number | null {
  const code = ZMK_KEYCODES[name.toUpperCase()];
  if (code === undefined) return null;
  return createHidUsage(HID_USAGE_PAGE_KEYBOARD, code);
}

/**
 * Resolve a full HID usage back to its canonical ZMK keycode name. Returns
 * null for non-keyboard pages, usages carrying implicit-modifier bits (bits
 * 24+, e.g. LS(...)-wrapped codes), and codes the table doesn't cover.
 */
export function usageToZmkKeycode(usage: number): string | null {
  // Implicit-modifier bits have no plain-name spelling.
  if (usage >>> 24 !== 0) return null;
  if (getHidUsagePage(usage) !== HID_USAGE_PAGE_KEYBOARD) return null;
  return ZMK_KEYCODE_CANONICAL_NAMES.get(getHidUsageCode(usage)) ?? null;
}

/** Resolve an `&mkp` param bitmask back to its canonical ZMK button name.
 * Returns null for combined masks and unknown values. */
export function mouseButtonsToZmkName(buttons: number): string | null {
  return ZMK_MOUSE_BUTTON_CANONICAL_NAMES.get(buttons) ?? null;
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

/**
 * Serialize a parsed binding back to its devicetree-style string, using
 * canonical keycode names. The exact inverse of {@link parseZmkBinding} on
 * canonical spellings (round-trip tested over the bundled preset). Returns
 * null when a usage has no plain ZMK name (non-keyboard page, implicit
 * modifiers, combined mouse-button masks).
 */
export function serializeZmkBinding(parsed: ParsedBinding): string | null {
  switch (parsed.type) {
    case "trans":
      return "&trans";
    case "none":
      return "&none";
    case "kp": {
      const name = usageToZmkKeycode(parsed.usage);
      return name === null ? null : `&kp ${name}`;
    }
    case "lt": {
      const name = usageToZmkKeycode(parsed.usage);
      return name === null ? null : `&lt ${parsed.layerIndex} ${name}`;
    }
    case "mt": {
      const mod = usageToZmkKeycode(parsed.modUsage);
      const name = usageToZmkKeycode(parsed.usage);
      return mod === null || name === null ? null : `&mt ${mod} ${name}`;
    }
    case "mkp": {
      const name = mouseButtonsToZmkName(parsed.buttons);
      return name === null ? null : `&mkp ${name}`;
    }
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
