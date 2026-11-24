// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelCatalogUpdateButton } from "@/model-discovery/index.js";
import { ModelRowInput } from "@/settings/model-provider-section/ProviderFormControls.js";
import {
  classifyModelCatalogError,
  useModelCatalogUpdate,
} from "@/model-discovery/useModelCatalogUpdate.js";
const current = vi.hoisted(() => ({
  service: { updateModelsFromCatalog: vi.fn() },
}));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ providerSettingsService: current.service }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "en-US",
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, unknown>) =>
        id + (values ? JSON.stringify(values) : ""),
    },
  }),
}));
const result = {
  view: {},
  matchedModelCount: 5,
  updated: [{ modelId: "plain", fields: ["contextWindow", "maxOutputTokens"] }],
  upToDateModelIds: ["fresh-enough"],
  manualModelIds: ["fixed"],
  reasoningChanged: [
    { modelId: "gpt-5", from: ["disabled", "enabled"], to: ["minimal", "low", "medium", "high"] },
  ],
  reasoningUnconfigured: [{ modelId: "deepseek-reasoner", reason: "no-levels" }],
  notFoundModelIds: ["fake-model-id"],
  conflictingFields: [],
};
beforeEach(() => {
  current.service = { updateModelsFromCatalog: vi.fn().mockResolvedValue(result) };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("one-click model catalog update", () => {
  it("runs on a single click with no source picker and shows updated / not-found models", async () => {
    render(
      createElement(ModelCatalogUpdateButton, { providerId: "mine", providerName: "My provider" }),
    );
    expect(current.service.updateModelsFromCatalog).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("model-catalog-update-open"));
    expect(current.service.updateModelsFromCatalog).toHaveBeenCalledWith("mine");
    expect(screen.queryByRole("combobox")).toBeNull();
    const status = await screen.findByTestId("model-catalog-result");
    expect(status.textContent).toContain('settings.modelProvider.catalog.matched{"count":5}');
    expect(screen.getByTestId("model-catalog-updated").textContent).toContain("plain");
    expect(screen.getByTestId("model-catalog-updated").textContent).toContain(
      "settings.modelProvider.catalog.field.contextWindow",
    );
    expect(screen.getByTestId("model-catalog-not-found").textContent).toContain("fake-model-id");
    expect(screen.getByTestId("model-catalog-manual").textContent).toContain("fixed");
    expect(screen.queryByTestId("model-catalog-builtin")).toBeNull();
    expect(screen.getByTestId("model-catalog-up-to-date").textContent).toContain("fresh-enough");
    expect(screen.queryByTestId("model-catalog-conflicting")).toBeNull();
  });
  it("lists reasoning level changes and unconfigured reasoning separately, without a 'not covered' note", async () => {
    render(createElement(ModelCatalogUpdateButton, { providerId: "mine" }));
    fireEvent.click(screen.getByTestId("model-catalog-update-open"));
    const changed = await screen.findByTestId("model-catalog-reasoning-changed");
    expect(changed.textContent).toContain("gpt-5");
    expect(changed.textContent).toContain("settings.modelProvider.catalog.reasoningFromTo");
    expect(changed.textContent).toContain("disabled / enabled");
    expect(changed.textContent).toContain("minimal / low / medium / high");
    const gaps = screen.getByTestId("model-catalog-reasoning-unconfigured");
    expect(gaps.textContent).toContain("deepseek-reasoner");
    expect(gaps.textContent).toContain("settings.modelProvider.catalog.reasoningGap.no-levels");
  });
  it("shows the fields skipped for lack of a majority, including partially updated models", async () => {
    current.service.updateModelsFromCatalog.mockResolvedValueOnce({
      ...result,
      conflictingFields: [{ modelId: "plain", fields: ["inputImage", "contextWindow"] }],
    });
    render(createElement(ModelCatalogUpdateButton, { providerId: "mine" }));
    fireEvent.click(screen.getByTestId("model-catalog-update-open"));
    const skipped = await screen.findByTestId("model-catalog-conflicting");
    expect(skipped.textContent).toContain("plain");
    expect(skipped.textContent).toContain("settings.modelProvider.catalog.field.inputImage");
    expect(skipped.textContent).toContain("settings.modelProvider.catalog.field.contextWindow");
    expect(screen.getByTestId("model-catalog-updated").textContent).toContain("plain");
  });
  it("reports zero matches and zero writes without claiming models are up to date", async () => {
    current.service.updateModelsFromCatalog.mockResolvedValueOnce({
      ...result,
      matchedModelCount: 0,
      updated: [],
      upToDateModelIds: [],
      manualModelIds: [],
      reasoningChanged: [],
      reasoningUnconfigured: [],
    });
    render(createElement(ModelCatalogUpdateButton, { providerId: "mine" }));
    fireEvent.click(screen.getByTestId("model-catalog-update-open"));
    const status = await screen.findByTestId("model-catalog-result");
    expect(status.textContent).toContain("settings.modelProvider.catalog.matchedNone");
    expect(screen.getByTestId("model-catalog-nothing-updated")).toBeTruthy();
    expect(screen.queryByTestId("model-catalog-up-to-date")).toBeNull();
  });
  it("shows saved catalog values when reopening the regular model editor", () => {
    const config = {
      properties: { contextWindow: 123456 },
      optionSpecs: { reasoningLevel: { values: ["low", "medium", "high"], map: null } },
    };
    const onCommit = vi.fn();
    render(
      createElement(ModelRowInput, {
        providerId: "mine",
        model: {
          kind: "candidate",
          modelId: "gateway/plain",
          builtin: false,
          personalConfig: config,
          config,
          hasPersonalConfig: true,
          executable: true,
          selectable: true,
        },
        onCommit,
      }),
    );
    const edit = screen.getByRole("button", { name: "settings.modelProvider.editModel" });
    fireEvent.click(edit);
    fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
    fireEvent.click(edit);
    expect(screen.getByDisplayValue("123456")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "settings.modelProvider.advancedConfig" }));
    for (const level of ["low", "medium", "high"]) {
      expect(screen.getByRole("button", { name: level })).toBeTruthy();
    }
    expect(onCommit).not.toHaveBeenCalled();
  });
  it.each([
    ["catalog-request-failed", "connect"],
    ["catalog-timeout", "timeout"],
    ["catalog-invalid-response", "invalid"],
    ["catalog-response-too-large", "invalid"],
    ["Error invoking remote method: catalog-timeout", "timeout"],
    ["Personal Provider Config revision conflict", "save"],
  ])("classifies %s as %s", (message, expected) => {
    expect(classifyModelCatalogError(new Error(message))).toBe(expected);
  });
  it("shows a distinct error that says config is unchanged, and retries", async () => {
    current.service.updateModelsFromCatalog.mockRejectedValueOnce(new Error("catalog-timeout"));
    render(createElement(ModelCatalogUpdateButton, { providerId: "mine" }));
    fireEvent.click(screen.getByTestId("model-catalog-update-open"));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "settings.modelProvider.catalog.error.timeout",
    );
    fireEvent.click(screen.getByTestId("model-catalog-update-retry"));
    await screen.findByTestId("model-catalog-result");
    expect(current.service.updateModelsFromCatalog).toHaveBeenCalledTimes(2);
  });
  it("blocks duplicate runs while one is in flight", async () => {
    let fail!: (error: Error) => void;
    current.service.updateModelsFromCatalog.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    const hook = renderHook(() => useModelCatalogUpdate("mine"));
    act(() => {
      void hook.result.current.run();
      void hook.result.current.run();
    });
    expect(current.service.updateModelsFromCatalog).toHaveBeenCalledTimes(1);
    expect(hook.result.current.updating).toBe(true);
    await act(async () => fail(new Error("catalog-request-failed")));
    expect(hook.result.current.error).toBe("connect");
    expect(hook.result.current.updating).toBe(false);
    await act(async () => hook.result.current.run());
    expect(hook.result.current.result?.updated).toHaveLength(1);
  });
  it("drops late feedback after a provider or Environment switch, or after closing", async () => {
    let finish!: (value: unknown) => void;
    current.service.updateModelsFromCatalog.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const hook = renderHook(({ id }) => useModelCatalogUpdate(id), { initialProps: { id: "a" } });
    act(() => {
      void hook.result.current.run();
    });
    hook.rerender({ id: "b" });
    await act(async () => finish(result));
    expect(hook.result.current.result).toBeNull();
    expect(hook.result.current.updating).toBe(false);
    act(() => {
      void hook.result.current.run();
    });
    current.service = { updateModelsFromCatalog: vi.fn() };
    hook.rerender({ id: "b" });
    await act(async () => finish(result));
    expect(hook.result.current.result).toBeNull();
    act(() => hook.result.current.reset());
    expect(hook.result.current.result).toBeNull();
    hook.unmount();
  });
  it("uses the page mutation callback so its owning view receives the authoritative result", async () => {
    const update = vi.fn().mockResolvedValue(result);
    const hook = renderHook(() => useModelCatalogUpdate("mine", update));
    await act(async () => hook.result.current.run());
    expect(update).toHaveBeenCalledWith("mine");
    expect(current.service.updateModelsFromCatalog).not.toHaveBeenCalled();
    expect(hook.result.current.result?.notFoundModelIds).toEqual(["fake-model-id"]);
  });
});
