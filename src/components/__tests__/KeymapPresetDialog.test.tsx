import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Keymap, Layer } from "@zmkfirmware/zmk-studio-ts-client/keymap";
import { KeymapPresetDialog } from "../KeymapPresetDialog";
import type { UseKeymapReturn } from "../../hooks/useKeymap";
import type { BehaviorDefinition } from "../../hooks/useKeymapSource";
import { KEYMAP_PRESETS } from "../../presets";

const KEY_COUNT = 66;

function behavior(id: number, displayName: string): BehaviorDefinition {
  return { id, displayName, metadata: [] };
}

const BEHAVIORS = new Map(
  [
    behavior(10, "Key Press"),
    behavior(29, "Layer-Tap"),
    behavior(34, "Mod-Tap"),
    behavior(3, "Mouse Key Press"),
    behavior(35, "Transparent"),
    behavior(36, "None"),
  ].map((b) => [b.id, b]),
);

/** A device keymap whose 4 layers are all-transparent 66-key layers with the
 * preset's layer names, so the diff is "every non-&trans key changes". */
function deviceKeymap(): Keymap {
  const names = ["default", "mouse", "fn", "scroll"];
  const layers: Layer[] = names.map((name, i) => ({
    id: i,
    name,
    bindings: Array.from({ length: KEY_COUNT }, () => ({
      behaviorId: 35,
      param1: 0,
      param2: 0,
    })),
  }));
  return { layers, availableLayers: 4, maxLayerNameLength: 20 };
}

function mockKeymap(overrides?: Partial<UseKeymapReturn>): UseKeymapReturn {
  return {
    keymap: deviceKeymap(),
    behaviors: BEHAVIORS,
    isLoading: false,
    getBindingDisplayName: (binding) =>
      `b${binding.behaviorId}:${binding.param1}:${binding.param2}`,
    addLayer: jest.fn(async () => null),
    setLayerName: jest.fn(async () => true),
    setBinding: jest.fn(async () => true),
    ...overrides,
  } as unknown as UseKeymapReturn;
}

function renderDialog(keymap: UseKeymapReturn) {
  return render(
    <KeymapPresetDialog
      open={true}
      onOpenChange={jest.fn()}
      keymap={keymap}
      physicalLayout={{
        name: "test",
        keys: Array.from({ length: KEY_COUNT }, (_, i) => ({
          x: (i % 12) * 100,
          y: Math.floor(i / 12) * 100,
          width: 100,
          height: 100,
          r: 0,
          rx: 0,
          ry: 0,
        })),
      }}
    />,
  );
}

describe("KeymapPresetDialog", () => {
  it("lists bundled presets and shows a diff after picking one", async () => {
    const keymap = mockKeymap();
    renderDialog(keymap);
    const user = userEvent.setup();

    const presetButton = screen.getByRole("button", {
      name: /Keyball-style/,
    });
    await user.click(presetButton);

    // Layer tabs from the preset, a mini-map, and a non-zero change count.
    await waitFor(() => {
      expect(screen.getByTestId("preset-diff-minimap")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /default/ })).toBeInTheDocument();
    expect(screen.getByText(/changes/)).toBeInTheDocument();
  });

  it("applies only changed bindings through setBinding and reports the result", async () => {
    const keymap = mockKeymap();
    renderDialog(keymap);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /Keyball-style/ }));
    await user.click(screen.getByRole("button", { name: /Apply Preset/ }));

    await waitFor(() => {
      expect(screen.getByTestId("preset-apply-result")).toBeInTheDocument();
    });

    const preset = KEYMAP_PRESETS.find((p) => p.id === "torabo-tsuki-keyball")!;
    const expectedChanges = preset.keymap.layers
      .flat()
      .filter((text) => text !== "&trans").length;
    expect(keymap.setBinding).toHaveBeenCalledTimes(expectedChanges);
    // Device layers already exist — no layer additions.
    expect(keymap.addLayer).not.toHaveBeenCalled();
    // Layer names already match — no renames.
    expect(keymap.setLayerName).not.toHaveBeenCalled();
    // Staging only: the dialog never saves to flash; that stays with the
    // keymap editor's own Save/Discard buttons.
  });

  it("marks bindings unappliable when the keyboard lacks a behavior and still applies the rest", async () => {
    const behaviors = new Map(BEHAVIORS);
    behaviors.delete(3); // no Mouse Key Press on this keyboard
    const keymap = mockKeymap({ behaviors });
    renderDialog(keymap);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /Keyball-style/ }));
    expect(screen.getByText(/not appliable/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Apply Preset/ }));
    await waitFor(() => {
      expect(screen.getByTestId("preset-apply-result")).toBeInTheDocument();
    });

    const preset = KEYMAP_PRESETS.find((p) => p.id === "torabo-tsuki-keyball")!;
    const expectedChanges = preset.keymap.layers
      .flat()
      .filter((text) => text !== "&trans" && !text.startsWith("&mkp")).length;
    expect(keymap.setBinding).toHaveBeenCalledTimes(expectedChanges);
  });
});
