import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderRuntime } from "../src/model-provider/providerRuntime.js";
import { createProviderConfigRuntime } from "../src/model-provider/providerConfigRuntime.js";
import { parseModelConfig, extractManualModelConfig } from "@zcode/provider";
import type { ModelCatalogProvider } from "@zcode/provider";

const disposers: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});
const source: ModelCatalogProvider = {
  sourceId: "example",
  name: "Example",
  models: [
    {
      modelId: "existing",
      config: {
        properties: { contextWindow: 9999, supportsToolCall: false },
        optionSpecs: { maxOutputTokens: { max: 4096 } },
      },
    },
    { modelId: "plain", config: { properties: { contextWindow: 123456 } } },
    { modelId: "fresh", config: { properties: { contextWindow: 777 } } },
  ],
};
async function setup(
  load = async (): Promise<readonly ModelCatalogProvider[]> => [source],
  inherited = false,
) {
  const dir = await mkdtemp(join(tmpdir(), "openzwork-catalog-"));
  disposers.push(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "provider_config.json");
  const builtinFile = join(dir, "source-builtin.json");
  const builtin = JSON.parse(await readFile(resolve("config/provider/zcode-builtin.json"), "utf8"));
  if (inherited)
    builtin.config.providerConfigRules.templateRules[1].config.builtinModelIds = ["existing"];
  await writeFile(builtinFile, JSON.stringify(builtin));
  const runtime = await startRuntime(dir, load);
  const service = runtime.providerSettings;
  const { providerId } = await service.createPersonalProvider({
    providerName: "Catalog test",
    ...(inherited ? { templateId: "standard-openai-chat-completions" } : {}),
    initialConfig: {
      api: { type: "openai-chat-completions", baseUrl: "https://example.invalid/v1" },
      access: { type: "api-key", apiKey: "fixture-only" },
    },
  });
  if (!inherited) {
    await service.addPersonalModel(
      providerId,
      "existing",
      {
        enabled: false,
        properties: { contextWindow: 1000 },
        optionSpecs: { reasoningLevel: { values: ["custom"], map: '{"custom": reasoningLevel}' } },
      },
      true,
    );
    await service.setPersonalModelEnabled(providerId, "existing", false);
  }
  await service.addPersonalModel(providerId, "plain", {}, true);
  await service.addPersonalModel(providerId, "fake-model-id", {}, true);
  return { runtime, service, providerId, file, builtinFile, dir };
}
async function startRuntime(
  dir: string,
  load: () => Promise<readonly ModelCatalogProvider[]>,
): Promise<ProviderRuntime> {
  const runtime = new ProviderRuntime({
    configRuntime: createProviderConfigRuntime({
      zcodeBuiltinFilePath: join(dir, "source-builtin.json"),
      zcodeBuiltinActiveFilePath: join(dir, "builtin.json"),
      personalFilePath: join(dir, "provider_config.json"),
      personalPollingIntervalMs: false,
      watch: false,
    }),
    loadModelCatalog: load,
  });
  disposers.push(() => runtime.dispose());
  await runtime.start();
  return runtime;
}
const levels = (levels: string[], toggle = false) => ({ toggle, budget: false, levels });
const managedIn = async (file: string) =>
  JSON.parse(await readFile(file, "utf8")).config.catalogManagedFields as
    | { providerId: string; modelId: string; fields: Record<string, unknown> }[]
    | undefined;
const providerOf = async (
  service: Awaited<ReturnType<typeof setup>>["service"],
  providerId: string,
) => (await service.getView()).providers.find((p) => p.providerId === providerId)!;

describe("one-click model details update through the owning Environment service", () => {
  it("fills only absent catalog fields of existing models, keeps user-set fields, never adds, and is idempotent", async () => {
    const { runtime, service, providerId, file } = await setup();
    const snapshot = await runtime.configService.read();
    const defaultModelSelection = {
      providerId,
      modelId: "existing",
      options: { reasoningLevel: "custom" },
    };
    await runtime.configService.replacePersonalConfig({
      providers: snapshot.personalProviders,
      models: snapshot.personalModels,
      providerOrder: snapshot.personalProviderOrder,
      defaultModelSelection,
    });
    await service.refresh("test-default-selection");
    const idsBefore = (await providerOf(service, providerId)).models.map((m) => m.modelId);

    const result = await service.updateModelsFromCatalog(providerId);
    expect(result.matchedModelCount).toBe(2);
    expect(result.updated.map((m) => m.modelId).sort()).toEqual(["existing", "plain"]);
    expect(result.updated.find((m) => m.modelId === "existing")!.fields).not.toContain(
      "contextWindow",
    );
    expect(result.notFoundModelIds).toEqual(["fake-model-id"]);
    expect(result.reasoningChanged).toEqual([]);

    const models = result.view.providers.find((p) => p.providerId === providerId)!.models;
    expect(models.map((m) => m.modelId)).toEqual(idsBefore);
    expect(models.map((m) => m.modelId)).not.toContain("fresh");
    const existing = models.find((m) => m.modelId === "existing")!;
    expect(existing).toMatchObject({
      enabled: false,
      personalExactConfig: {
        properties: { contextWindow: 1000, supportsToolCall: false },
        optionSpecs: {
          reasoningLevel: { values: ["custom"] },
          maxOutputTokens: { max: 4096 },
        },
      },
    });
    expect(existing.effectiveConfig.properties?.contextWindow).toBe(1000);
    const plain = models.find((m) => m.modelId === "plain")!;
    expect(plain.effectiveConfig.properties?.contextWindow).toBe(123456);
    const fake = models.find((m) => m.modelId === "fake-model-id")!;
    expect(fake.personalExactConfig?.properties?.contextWindow).toBeUndefined();

    const once = await readFile(file, "utf8");
    expect(JSON.parse(once).config.defaultModelSelection).toEqual(defaultModelSelection);
    const second = await service.updateModelsFromCatalog(providerId);
    expect(second.updated).toEqual([]);
    expect(second.upToDateModelIds.toSorted()).toEqual(["existing", "plain"]);
    expect(await readFile(file, "utf8")).toBe(once);
  });

  it("propagates classified catalog errors and writes nothing; a deleted provider is rejected", async () => {
    let failure: string | null = "catalog-timeout";
    const { service, providerId, file } = await setup(async () => {
      if (failure) throw new Error(failure);
      return [source];
    });
    const before = await readFile(file, "utf8");
    for (const code of ["catalog-timeout", "catalog-request-failed", "catalog-invalid-response"]) {
      failure = code;
      await expect(service.updateModelsFromCatalog(providerId)).rejects.toThrow(code);
      expect(await readFile(file, "utf8")).toBe(before);
    }
    failure = null;
    await service.deletePersonalProvider(providerId);
    const deleted = await readFile(file, "utf8");
    await expect(service.updateModelsFromCatalog(providerId)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(deleted);
  });

  it("rejects the whole batch when one value is invalid, leaving the file untouched", async () => {
    const { service, providerId, file } = await setup(async () => [
      {
        ...source,
        models: [
          { modelId: "existing", config: { optionSpecs: { maxOutputTokens: { max: 4096 } } } },
          { modelId: "plain", config: { properties: { contextWindow: -1 } } },
        ],
      },
    ]);
    const before = await readFile(file, "utf8");
    await expect(service.updateModelsFromCatalog(providerId)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("updates inherited built-in models through the personal overlay, never the built-in file or membership", async () => {
    const { service, providerId, file, builtinFile } = await setup(undefined, true);
    const { providerId: otherId } = await service.createPersonalProvider({
      providerName: "Do not touch",
    });
    const otherBefore = (await service.getView()).providers.find((p) => p.providerId === otherId);
    const builtinBefore = await readFile(builtinFile, "utf8");
    const orderBefore = JSON.parse(await readFile(file, "utf8")).config.providerOrder;
    const result = await service.updateModelsFromCatalog(providerId);
    expect(result.updated.map((m) => m.modelId).sort()).toEqual(["existing", "plain"]);
    const provider = result.view.providers.find((p) => p.providerId === providerId)!;
    expect(provider.effectiveConfig.builtinModelIds).toEqual(["existing"]);
    const existing = provider.models.find((m) => m.modelId === "existing")!;
    expect(existing.personalExactConfig).toMatchObject({
      properties: { contextWindow: 9999, supportsToolCall: false },
      optionSpecs: { maxOutputTokens: { max: 4096 } },
    });
    expect(existing.effectiveConfig.properties?.contextWindow).toBe(9999);
    expect(provider.models.map((m) => m.modelId)).toEqual(["existing", "plain", "fake-model-id"]);
    expect(result.view.providers.find((p) => p.providerId === otherId)).toEqual(otherBefore);
    expect(JSON.parse(await readFile(file, "utf8")).config.providerOrder).toEqual(orderBefore);
    expect(await readFile(builtinFile, "utf8")).toBe(builtinBefore);
    expect(await managedIn(file)).toContainEqual({
      providerId,
      modelId: "existing",
      fields: { contextWindow: 9999, supportsToolCall: false, maxOutputTokens: 4096 },
    });
  });

  it("is repeatable: a later click refreshes catalog-written fields, also after a restart", async () => {
    let catalog: ModelCatalogProvider[] = [source];
    const ctx = await setup(async () => catalog, true);
    await ctx.service.updateModelsFromCatalog(ctx.providerId);
    catalog = [
      {
        ...source,
        models: source.models.map((model) =>
          model.modelId === "existing"
            ? {
                ...model,
                config: {
                  ...model.config,
                  properties: { contextWindow: 20000, supportsToolCall: true },
                },
              }
            : model,
        ),
      },
    ];
    // 重启：记录随个人配置文件持久化。
    const restarted = await startRuntime(ctx.dir, async () => catalog);
    const second = await restarted.providerSettings.updateModelsFromCatalog(ctx.providerId);
    expect(second.updated).toEqual([
      { modelId: "existing", fields: ["contextWindow", "supportsToolCall"] },
    ]);
    const existing = second.view.providers
      .find((p) => p.providerId === ctx.providerId)!
      .models.find((m) => m.modelId === "existing")!;
    expect(existing.effectiveConfig.properties).toMatchObject({
      contextWindow: 20000,
      supportsToolCall: true,
    });
    expect((await managedIn(ctx.file))!.find((e) => e.modelId === "existing")!.fields).toEqual({
      contextWindow: 20000,
      supportsToolCall: true,
      maxOutputTokens: 4096,
    });
  });

  it("hands a catalog-written field to the user once edited, and drops it from the record", async () => {
    let catalog: ModelCatalogProvider[] = [source];
    const { service, providerId, file } = await setup(async () => catalog, true);
    await service.updateModelsFromCatalog(providerId);
    const view = await service.getView();
    const existing = view.providers
      .find((p) => p.providerId === providerId)!
      .models.find((m) => m.modelId === "existing")!;
    await service.savePersonalModelDraft({
      providerId,
      originalModelId: "existing",
      nextModelId: "existing",
      personalConfig: {
        ...existing.personalExactConfig,
        properties: { ...existing.personalExactConfig!.properties, contextWindow: 32000 },
      },
      useRecommendedConfig: true,
      basedOnRevision: view.revision,
    });
    catalog = [
      {
        ...source,
        models: source.models.map((model) =>
          model.modelId === "existing"
            ? {
                ...model,
                config: {
                  properties: { contextWindow: 50000, supportsToolCall: false },
                  optionSpecs: { maxOutputTokens: { max: 8192 } },
                },
              }
            : model,
        ),
      },
    ];
    const result = await service.updateModelsFromCatalog(providerId);
    expect(result.updated).toEqual([{ modelId: "existing", fields: ["maxOutputTokens"] }]);
    const after = result.view.providers
      .find((p) => p.providerId === providerId)!
      .models.find((m) => m.modelId === "existing")!;
    expect(after.effectiveConfig.properties?.contextWindow).toBe(32000);
    expect(after.effectiveConfig.optionSpecs?.maxOutputTokens?.max).toBe(8192);
    expect((await managedIn(file))!.find((e) => e.modelId === "existing")!.fields).toEqual({
      supportsToolCall: false,
      maxOutputTokens: 8192,
    });
    // 已归用户的字段之后也不再被目录改动。
    const again = await service.updateModelsFromCatalog(providerId);
    expect(again.updated).toEqual([]);
  });

  it("writes catalog reasoning levels with the existing per-API mapping and follows the same ownership rules", async () => {
    let catalog: ModelCatalogProvider[] = [
      {
        ...source,
        models: [
          { ...source.models[0]!, reasoning: levels(["disabled", "low", "high"], true) },
          {
            modelId: "plain",
            config: { properties: { contextWindow: 123456 } },
            reasoning: { toggle: false, budget: false },
          },
        ],
      },
    ];
    const { service, providerId, file } = await setup(async () => catalog, true);
    const before = (await providerOf(service, providerId)).models.find(
      (m) => m.modelId === "existing",
    )!;
    const from = before.effectiveConfig.optionSpecs?.reasoningLevel?.values;
    expect(from).toEqual(["disabled", "enabled"]);
    const first = await service.updateModelsFromCatalog(providerId);
    expect(first.reasoningChanged).toEqual([
      { modelId: "existing", from: ["disabled", "enabled"], to: ["disabled", "low", "high"] },
    ]);
    expect(first.reasoningUnconfigured).toEqual([{ modelId: "plain", reason: "no-levels" }]);
    const existing = first.view.providers
      .find((p) => p.providerId === providerId)!
      .models.find((m) => m.modelId === "existing")!;
    // 只写档位，沿用仓库为该 API 类型给出的映射；映射本身不进个人覆盖层。
    expect(existing.personalExactConfig?.optionSpecs?.reasoningLevel).toEqual({
      values: ["disabled", "low", "high"],
    });
    expect(existing.effectiveConfig.optionSpecs?.reasoningLevel?.map).toBe(
      before.effectiveConfig.optionSpecs?.reasoningLevel?.map,
    );

    catalog = [
      {
        ...catalog[0]!,
        models: [
          { ...source.models[0]!, reasoning: levels(["disabled", "low", "medium", "high"], true) },
        ],
      },
    ];
    const second = await service.updateModelsFromCatalog(providerId);
    expect(second.reasoningChanged).toEqual([
      {
        modelId: "existing",
        from: ["disabled", "low", "high"],
        to: ["disabled", "low", "medium", "high"],
      },
    ]);

    const view = await service.getView();
    const current = view.providers
      .find((p) => p.providerId === providerId)!
      .models.find((m) => m.modelId === "existing")!;
    await service.savePersonalModelDraft({
      providerId,
      originalModelId: "existing",
      nextModelId: "existing",
      personalConfig: {
        ...current.personalExactConfig,
        optionSpecs: {
          ...current.personalExactConfig!.optionSpecs,
          reasoningLevel: { values: ["disabled", "high"] },
        },
      },
      useRecommendedConfig: true,
      basedOnRevision: view.revision,
    });
    catalog = [
      {
        ...catalog[0]!,
        models: [
          {
            ...source.models[0]!,
            reasoning: levels(["disabled", "low", "medium", "high", "max"], true),
          },
        ],
      },
    ];
    const third = await service.updateModelsFromCatalog(providerId);
    expect(third.reasoningChanged).toEqual([]);
    expect(third.reasoningUnconfigured).toEqual([]);
    expect(
      third.view.providers
        .find((p) => p.providerId === providerId)!
        .models.find((m) => m.modelId === "existing")!.effectiveConfig.optionSpecs?.reasoningLevel
        ?.values,
    ).toEqual(["disabled", "high"]);
    const record = (await managedIn(file))!.find((e) => e.modelId === "existing")!;
    expect(record.fields.reasoningLevels).toBeUndefined();
  });

  it.each([
    { map: null },
    { map: '{"thinking":{"type": reasoningLevel == "disabled" ? "disabled" : "enabled"}}' },
  ])("writes directory levels using the editor's config format with map $map", async ({ map }) => {
    const modelId = "gateway/plain";
    const importedLevels = ["low", "medium", "high"];
    const load = async () => [
      {
        ...source,
        models: [
          { ...source.models[0]!, reasoning: levels(["low", "high"]) },
          {
            ...source.models[1]!,
            modelId: "vendor/PLAIN",
            reasoning: levels(importedLevels),
          },
        ],
      },
    ];
    const { service, providerId, file, dir } = await setup(load);
    await service.addPersonalModel(
      providerId,
      modelId,
      {
        optionSpecs: { reasoningLevel: { map } },
      },
      true,
    );

    const result = await service.updateModelsFromCatalog(providerId);
    expect(result.reasoningChanged.map(({ modelId, to }) => ({ modelId, to }))).toContainEqual({
      modelId,
      to: importedLevels,
    });
    expect(result.reasoningUnconfigured).toEqual([]);
    const rules = JSON.parse(await readFile(file, "utf8")).config.modelConfigRules
      .providerModelRules;
    expect(rules).toContainEqual({
      providerId,
      modelId,
      config: {
        enabled: true,
        properties: { contextWindow: 123456 },
        optionSpecs: { reasoningLevel: { map, values: importedLevels } },
      },
    });
    expect(rules).toContainEqual(
      expect.objectContaining({
        providerId,
        modelId: "existing",
        config: expect.objectContaining({
          optionSpecs: expect.objectContaining({
            reasoningLevel: { map: '{"custom": reasoningLevel}', values: ["custom"] },
          }),
        }),
      }),
    );
    expect(await managedIn(file)).toContainEqual({
      providerId,
      modelId,
      fields: { contextWindow: 123456, reasoningLevels: importedLevels },
    });

    const restarted = await startRuntime(dir, load);
    const provider = await providerOf(restarted.providerSettings, providerId);
    const persisted = provider.models.find((model) => model.modelId === modelId)!;
    expect(persisted.personalExactConfig?.optionSpecs?.reasoningLevel).toEqual({
      map,
      values: importedLevels,
    });
    expect(persisted.effectiveConfig.optionSpecs?.reasoningLevel?.values).toEqual(importedLevels);
  });

  it("reports fields with no majority while saving other fields of the same model", async () => {
    const { service, providerId } = await setup(async () => [
      source,
      {
        sourceId: "other",
        name: "Other",
        models: [
          {
            modelId: "vendor/PLAIN",
            config: {
              properties: { contextWindow: 98765 },
              optionSpecs: { maxOutputTokens: { max: 8192 } },
            },
          },
        ],
      },
    ]);
    const first = await service.updateModelsFromCatalog(providerId);
    expect(first.matchedModelCount).toBe(2);
    expect(first.conflictingFields).toEqual([{ modelId: "plain", fields: ["contextWindow"] }]);
    expect(first.updated).toContainEqual({ modelId: "plain", fields: ["maxOutputTokens"] });
    const second = await service.updateModelsFromCatalog(providerId);
    expect(second.updated).toEqual([]);
    expect(second.conflictingFields).toEqual(first.conflictingFields);
    expect(second.upToDateModelIds).not.toContain("plain");
  });

  it("preserves fixed (manual) model configs entirely and reports them", async () => {
    const { runtime, service, providerId, file } = await setup();
    const snapshot = await runtime.configService.read();
    const baseline = (await providerOf(service, providerId)).models.find(
      (m) => m.modelId === "plain",
    )!.effectiveConfig;
    await runtime.configService.replacePersonalConfig({
      providers: snapshot.personalProviders,
      models: snapshot.personalModels
        .setExact(
          providerId,
          "plain",
          parseModelConfig(
            extractManualModelConfig({
              ...baseline,
              properties: { ...baseline.properties, contextWindow: 42 },
            }),
          ),
          false,
        )
        .deleteExact(providerId, "existing")
        .setExact(
          providerId,
          "existing",
          parseModelConfig({
            properties: { contextWindow: 9999, supportsToolCall: false },
            optionSpecs: { maxOutputTokens: { max: 4096 } },
          }),
          true,
        ),
      providerOrder: snapshot.personalProviderOrder,
    });
    await service.refresh("test-manual-rule");
    const before = await readFile(file, "utf8");
    const result = await service.updateModelsFromCatalog(providerId);
    expect(result.manualModelIds).toEqual(["plain"]);
    expect(result.upToDateModelIds).toEqual(["existing"]);
    expect(result.updated).toEqual([]);
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("serializes concurrent clicks: one run updates, the other finds everything up to date", async () => {
    const { service, providerId } = await setup();
    const results = await Promise.all([
      service.updateModelsFromCatalog(providerId),
      service.updateModelsFromCatalog(providerId),
    ]);
    expect(results.map((result) => result.updated.length).sort()).toEqual([0, 2]);
    const provider = await providerOf(service, providerId);
    expect(provider.models.map((model) => model.modelId)).toEqual([
      "existing",
      "plain",
      "fake-model-id",
    ]);
  });
});
