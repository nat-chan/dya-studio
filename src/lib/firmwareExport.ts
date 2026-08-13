/**
 * Firmware backport serializers: turn the CURRENT on-device state (keymap
 * loaded via the standard keymap RPCs + runtime-accel curves) back into the
 * firmware repo's source files, so the user's tuned settings become the
 * compiled-in defaults.
 *
 * Three generators, all working on the FETCHED current file content so that
 * everything outside the replaced regions (includes, combos, comments, extra
 * devicetree nodes) is preserved byte-for-byte:
 *
 * - `renderKeymapKeymap`  — config/keymap.keymap: replaces only the per-layer
 *   nodes inside the `zmk,keymap` node. The binding grid shape (bindings per
 *   row) and the column-aligned right-padded cell formatting are derived from
 *   the existing file, not hardcoded.
 * - `renderKeymapJson`    — config/keymap.json: replaces `layer_names` and
 *   `layers`, keeping every other top-level field and the aligned-grid layer
 *   formatting.
 * - `replaceDefaultCurve` — shield overlays: replaces the `default-curve`
 *   values of the runtime-accel nodes, matched by `instance-id`.
 *
 * Device bindings are reverse-serialized through the SAME mapping tables the
 * preset feature parses with (see keymapPreset.ts): parse -> serialize is the
 * identity on canonical spellings, so backporting an unchanged keymap yields
 * no diff.
 */

import type {
  BehaviorBinding,
  Keymap,
} from "@zmkfirmware/zmk-studio-ts-client/keymap";
import type { BehaviorDefinition } from "../hooks/useKeymapSource";
import {
  buildBehaviorIdIndex,
  serializeZmkBinding,
  type ParsedBinding,
} from "./keymapPreset";

// ---------------------------------------------------------------------------
// Device keymap -> devicetree binding strings
// ---------------------------------------------------------------------------

/** Serialized on-device keymap plus everything that could not be expressed. */
export interface SerializedKeymap {
  layerNames: string[];
  /** One array of devicetree binding strings per layer, indexed by key
   * position. Unserializable bindings are exported as `&trans` and reported
   * in {@link SerializedKeymap.warnings}. */
  layers: string[][];
  warnings: SerializeWarning[];
}

export interface SerializeWarning {
  layerIndex: number;
  layerName: string;
  keyPosition: number;
  /** Human-readable description of the binding that could not be serialized
   * (behavior display name + params). */
  binding: string;
}

/** Fallback emitted for bindings with no devicetree spelling. */
export const UNSERIALIZABLE_FALLBACK = "&trans";

/**
 * Invert {@link buildBehaviorIdIndex}: device behaviorId -> parsed-binding
 * type, for the behaviors the serializer understands (kp/lt/mt/mkp/trans/
 * none). Built from the same behavior-metadata matching the preset parser
 * uses, so both directions stay in sync.
 */
export function buildBehaviorTypeIndex(
  behaviors: Map<number, BehaviorDefinition>,
): Map<number, ParsedBinding["type"]> {
  const index = new Map<number, ParsedBinding["type"]>();
  for (const [type, id] of buildBehaviorIdIndex(behaviors)) {
    index.set(id, type);
  }
  return index;
}

/**
 * Map one device binding into the parser's {@link ParsedBinding} form.
 * Returns null when the behavior is not one the devicetree serializer
 * understands (macros, custom behaviors, ...) or an `&lt` targets an
 * unknown layer id.
 */
export function deviceBindingToParsed(
  binding: BehaviorBinding,
  typeByBehaviorId: Map<number, ParsedBinding["type"]>,
  layerIndexById: Map<number, number>,
): ParsedBinding | null {
  const type = typeByBehaviorId.get(binding.behaviorId);
  switch (type) {
    case "kp":
      return { type, usage: binding.param1 };
    case "lt": {
      const layerIndex = layerIndexById.get(binding.param1);
      if (layerIndex === undefined) return null;
      return { type, layerIndex, usage: binding.param2 };
    }
    case "mt":
      return { type, modUsage: binding.param1, usage: binding.param2 };
    case "mkp":
      return { type, buttons: binding.param1 };
    case "bt":
      return { type, command: binding.param1, arg: binding.param2 };
    case "out":
      return { type, command: binding.param1 };
    case "trans":
    case "none":
      return { type };
    default:
      return null;
  }
}

/**
 * Serialize the full on-device keymap (as loaded by the keymap editor) into
 * per-layer devicetree binding strings. Bindings that cannot be expressed are
 * exported as {@link UNSERIALIZABLE_FALLBACK} and reported as warnings so the
 * diff preview can surface them instead of silently dropping them.
 */
export function serializeDeviceKeymap(
  keymap: Keymap,
  behaviors: Map<number, BehaviorDefinition>,
): SerializedKeymap {
  const typeByBehaviorId = buildBehaviorTypeIndex(behaviors);
  const layerIndexById = new Map(keymap.layers.map((l, i) => [l.id, i]));
  const warnings: SerializeWarning[] = [];

  const layers = keymap.layers.map((layer, layerIndex) =>
    layer.bindings.map((binding, keyPosition) => {
      const parsed = deviceBindingToParsed(
        binding,
        typeByBehaviorId,
        layerIndexById,
      );
      const text = parsed === null ? null : serializeZmkBinding(parsed);
      if (text !== null) return text;
      const displayName =
        behaviors.get(binding.behaviorId)?.displayName ??
        `behavior #${binding.behaviorId}`;
      warnings.push({
        layerIndex,
        layerName: layer.name,
        keyPosition,
        binding: `${displayName} (${binding.param1}, ${binding.param2})`,
      });
      return UNSERIALIZABLE_FALLBACK;
    }),
  );

  return {
    layerNames: keymap.layers.map((l) => l.name),
    layers,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Aligned binding grids
// ---------------------------------------------------------------------------

/** Thrown when the fetched firmware file doesn't look like what the
 * generators expect (no keymap node, key-count mismatch, ...). */
export type FirmwareFormatErrorReason =
  | "no-keymap-node"
  | "no-layer-nodes"
  | "key-count-mismatch"
  | "instance-not-found";

export class FirmwareFormatError extends Error {
  /** Which structural assumption failed — drives the i18n'd UI message. */
  readonly reason: FirmwareFormatErrorReason;

  constructor(message: string, reason: FirmwareFormatErrorReason) {
    super(message);
    this.name = "FirmwareFormatError";
    this.reason = reason;
  }
}

/**
 * Split a flat per-layer cell list into the grid rows of the existing file
 * (e.g. 12/12/14/14/14 for Torabo-Tsuki), then align cells into columns:
 * every row's cells are right-aligned into per-column widths, and rows with
 * fewer cells than the widest row leave a centered gap (the split-half gap in
 * the source files). `separator` spaces sit between columns; `indent`
 * prefixes each line.
 */
function formatAlignedGrid(
  cells: string[],
  rowLengths: number[],
  indent: string,
  separator: string,
): string[] {
  const expected = rowLengths.reduce((a, b) => a + b, 0);
  if (cells.length !== expected) {
    throw new FirmwareFormatError(
      `keymap has ${cells.length} bindings per layer but the firmware file's grid has ${expected}`,
      "key-count-mismatch",
    );
  }
  const totalColumns = Math.max(...rowLengths);

  // Row cells -> grid columns, keeping short rows' gap centered.
  const grid: string[][] = [];
  let offset = 0;
  for (const length of rowLengths) {
    const row = cells.slice(offset, offset + length);
    offset += length;
    const left = Math.ceil(length / 2);
    const columns = Array.from({ length: totalColumns }, (_, c) => {
      if (c < left) return row[c] ?? "";
      if (c >= totalColumns - (length - left)) {
        return row[c - (totalColumns - length)] ?? "";
      }
      return "";
    });
    grid.push(columns);
  }

  const widths = Array.from({ length: totalColumns }, (_, c) =>
    Math.max(...grid.map((row) => row[c].length)),
  );

  return grid.map(
    (row) =>
      indent + row.map((cell, c) => cell.padStart(widths[c])).join(separator),
  );
}

// ---------------------------------------------------------------------------
// config/keymap.keymap
// ---------------------------------------------------------------------------

interface LayerNodeMatch {
  start: number;
  end: number;
  indent: string;
  bindingsIndent: string;
  /** The raw grid text between `bindings = <` and `>;`. */
  rawGrid: string;
  rows: string[][];
}

/** Find the inner span (between the braces) of the `zmk,keymap` node. */
function findKeymapNodeSpan(content: string): { start: number; end: number } {
  const compatible = content.search(/compatible\s*=\s*"zmk,keymap"/);
  if (compatible < 0) {
    throw new FirmwareFormatError(
      'no compatible = "zmk,keymap" node found',
      "no-keymap-node",
    );
  }
  const open = content.lastIndexOf("{", compatible);
  let depth = 1;
  for (let i = open + 1; i < content.length; i++) {
    if (content[i] === "{") depth++;
    else if (content[i] === "}" && --depth === 0) {
      return { start: open + 1, end: i };
    }
  }
  throw new FirmwareFormatError("unbalanced braces", "no-keymap-node");
}

/** Split one bindings-grid line into cells (each starting with `&`). */
function splitGridRow(line: string): string[] {
  return line
    .trim()
    .split(/\s+(?=&)/)
    .filter((cell) => cell.length > 0);
}

/** Locate every layer node (a child node containing `bindings = <...>;`)
 * inside the keymap node, with its formatting details. */
function findLayerNodes(content: string): LayerNodeMatch[] {
  const span = findKeymapNodeSpan(content);
  const inner = content.slice(span.start, span.end);
  const nodeRe =
    /^([ \t]+)[A-Za-z_][\w-]*\s*\{[^{}]*?\n([ \t]*)bindings\s*=\s*<\n([\s\S]*?)\n[ \t]*>\s*;[^{}]*?\}\s*;/gm;
  const nodes: LayerNodeMatch[] = [];
  for (const match of inner.matchAll(nodeRe)) {
    nodes.push({
      start: span.start + match.index,
      end: span.start + match.index + match[0].length,
      indent: match[1],
      bindingsIndent: match[2],
      rawGrid: match[3],
      rows: match[3]
        .split("\n")
        .map(splitGridRow)
        .filter((row) => row.length > 0),
    });
  }
  if (nodes.length === 0) {
    throw new FirmwareFormatError(
      "no layer nodes with bindings found",
      "no-layer-nodes",
    );
  }
  return nodes;
}

/** Devicetree node name for a layer, following the source file's convention
 * (`default_layer`, `layer_mouse`, ...). */
export function layerNodeName(name: string, layerIndex: number): string {
  let sanitized = name.replace(/[^A-Za-z0-9_]/g, "_");
  if (sanitized.length === 0) sanitized = `${layerIndex}`;
  if (sanitized === "default") return "default_layer";
  if (/^default_layer$|^layer_/.test(sanitized)) return sanitized;
  return `layer_${sanitized}`;
}

/** Grid shape (bindings per row) of the existing file's first layer node. */
export function deriveGridRowLengths(existingKeymap: string): number[] {
  return findLayerNodes(existingKeymap)[0].rows.map((row) => row.length);
}

/**
 * Replace the layer nodes of config/keymap.keymap with the serialized
 * on-device keymap. Everything before the first layer node and after the last
 * (includes, combos, comments, the keymap node shell) is preserved
 * byte-for-byte; the binding grid keeps the existing file's row shape and
 * column-aligned formatting.
 */
export function renderKeymapKeymap(
  existing: string,
  serialized: Pick<SerializedKeymap, "layerNames" | "layers">,
): string {
  const nodes = findLayerNodes(existing);
  const first = nodes[0];
  const rowLengths = first.rows.map((row) => row.length);
  // Grid lines in the source start almost at column 0 (an indent of one
  // space), independent of the node indent: derive the smallest leading
  // whitespace of the existing grid instead of assuming it.
  const gridIndent =
    first.rawGrid
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .reduce(
        (shortest, line) => {
          const leading = line.match(/^[ \t]*/)?.[0] ?? "";
          return shortest === null || leading.length < shortest.length
            ? leading
            : shortest;
        },
        null as string | null,
      ) ?? " ";

  const rendered = serialized.layers.map((cells, layerIndex) => {
    const name = layerNodeName(
      serialized.layerNames[layerIndex] ?? `layer_${layerIndex}`,
      layerIndex,
    );
    const lines = formatAlignedGrid(cells, rowLengths, gridIndent, "  ");
    return [
      `${first.indent}${name} {`,
      `${first.bindingsIndent}bindings = <`,
      ...lines,
      `${first.bindingsIndent}>;`,
      `${first.indent}};`,
    ].join("\n");
  });

  return (
    existing.slice(0, first.start) +
    rendered.join("\n\n") +
    existing.slice(nodes[nodes.length - 1].end)
  );
}

// ---------------------------------------------------------------------------
// config/keymap.json
// ---------------------------------------------------------------------------

/**
 * Replace `layer_names` and `layers` in config/keymap.json, re-rendering the
 * file with its established formatting: 2-space indent for scalar fields (in
 * their original order), one name per line, and layers as aligned grids of
 * quoted binding strings in the same row shape as the devicetree keymap.
 */
export function renderKeymapJson(
  existing: string,
  serialized: Pick<SerializedKeymap, "layerNames" | "layers">,
  rowLengths: number[],
): string {
  const parsed = JSON.parse(existing) as Record<string, unknown>;
  parsed.layer_names = serialized.layerNames;
  parsed.layers = serialized.layers;

  const parts = Object.entries(parsed).map(([key, value]) => {
    if (key === "layer_names") {
      const names = serialized.layerNames
        .map((name) => `    ${JSON.stringify(name)}`)
        .join(",\n");
      return `  "layer_names": [\n${names}\n  ]`;
    }
    if (key === "layers") {
      const grids = serialized.layers.map((cells) => {
        // Align including a trailing comma on every cell, then drop the very
        // last cell's comma (matching the existing file's formatting).
        const lines = formatAlignedGrid(
          cells.map((cell) => `${JSON.stringify(cell)},`),
          rowLengths,
          "       ",
          " ",
        );
        const lastLine = lines.length - 1;
        lines[lastLine] = lines[lastLine].replace(/,$/, "");
        return lines.join("\n");
      });
      return `  "layers": [\n    [\n${grids.join("\n    ], [\n")}\n    ]\n  ]`;
    }
    // Any other field: standard 2-space-indented JSON, shifted under the key.
    const rendered = JSON.stringify(value, null, 2)
      .split("\n")
      .map((line, i) => (i === 0 ? line : `  ${line}`))
      .join("\n");
    return `  ${JSON.stringify(key)}: ${rendered}`;
  });

  return `{\n${parts.join(",\n")}\n}\n`;
}

// ---------------------------------------------------------------------------
// Shield overlays: default-curve replacement
// ---------------------------------------------------------------------------

/**
 * Replace the `default-curve = <...>;` value of the runtime-accel node whose
 * `instance-id` matches, keeping all other formatting. `points` is the
 * interleaved [speed0, factor0, speed1, factor1, ...] list as served by
 * GetCurve.
 */
export function replaceDefaultCurve(
  overlay: string,
  instanceId: string,
  points: number[],
): string {
  const re = new RegExp(
    `(instance-id = "${instanceId}";[^{}]*?default-curve = <)[^>]*(>)`,
  );
  if (!re.test(overlay)) {
    throw new FirmwareFormatError(
      `no runtime-accel node with instance-id "${instanceId}"`,
      "instance-not-found",
    );
  }
  return overlay.replace(re, `$1${points.join(" ")}$2`);
}
