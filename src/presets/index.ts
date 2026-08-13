/**
 * Bundled keymap presets.
 *
 * toraboTsukiKeyballKeymap.json is a verbatim copy of
 * nat-chan/zmk-keyboard-torabo-tsuki-lp config/keymap.json (4 layers named
 * default/mouse/fn/scroll, 66 keys each) — a Keyball-style layout with mouse
 * buttons on the home row and layer-taps for symbols.
 */
import type {
  KeymapPresetDefinition,
  PresetKeymapJson,
} from "../lib/keymapPreset";
import toraboTsukiKeyballKeymap from "./toraboTsukiKeyballKeymap.json";

export const KEYMAP_PRESETS: KeymapPresetDefinition[] = [
  {
    id: "torabo-tsuki-keyball",
    name: "Keyball-style (Torabo-Tsuki LP)",
    description:
      "Keyball-style layout for Torabo-Tsuki LP: mouse buttons on the home row, layer-taps for symbols, JIS-friendly punctuation.",
    keymap: toraboTsukiKeyballKeymap as PresetKeymapJson,
  },
];
