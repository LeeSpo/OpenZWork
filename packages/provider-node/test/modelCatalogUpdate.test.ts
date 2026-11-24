import { describe, expect, it, vi } from "vitest";
import {
  matchModelCatalog,
  planManagedCatalogPatch,
  type ModelCatalogProvider,
} from "@zcode/provider";
import { createModelsDevCatalog } from "../src/model-discovery/index.js";

const chat = {
  id: "future-chat",
  name: "Future chat",
  tool_call: true,
  structured_output: true,
  reasoning: true,
  reasoning_options: [{ type: "effort", values: ["low", "high"] }],
  limit: { context: 123456, output: 8192 },
  modalities: { input: ["text", "image"], output: ["text"] },
};
const fixture = (models = { "future-chat": chat }) => ({
  example: { id: "example", name: "Example", models },
});

describe("manual model catalog update", () => {
  it("fetches only the public catalog without provider credentials and imports metadata, not guessed reasoning maps", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(fixture()));
    const catalog = await createModelsDevCatalog(fetcher).load();
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({ sourceId: "example", name: "Example" });
    expect(catalog[0]!.models[0]).toMatchObject({
      modelId: "future-chat",
      config: {
        properties: {
          contextWindow: 123456,
          supportsToolCall: true,
          supportsJsonSchemaOutput: true,
          inputFormat: { supportsText: true, supportsImage: true },
        },
        optionSpecs: { maxOutputTokens: { max: 8192 } },
      },
    });
    // 档位只作为目录事实带出，不在目录层生成任何请求参数映射。
    expect(catalog[0]!.models[0]!.config.optionSpecs?.reasoningLevel).toBeUndefined();
    expect(catalog[0]!.models[0]!.reasoning).toEqual({
      toggle: false,
      budget: false,
      levels: ["low", "high"],
    });
    expect(String(fetcher.mock.calls[0]![0])).toBe("https://models.dev/api.json");
    const init = fetcher.mock.calls[0]![1]!;
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init.headers).has("authorization")).toBe(false);
  });
  it("filters embeddings even when their output modality says text, retired models and image/audio generators", async () => {
    const models = {
      good: { ...chat, id: "good" },
      embedded: { ...chat, id: "embedded", type: "embedding" },
      family: { ...chat, id: "family", family: "text-embedding" },
      reranker: { ...chat, id: "reranker", type: "rerank" },
      old: { ...chat, id: "old", status: "deprecated" },
      retired: { ...chat, id: "retired", status: "retired" },
      image: { ...chat, id: "image", modalities: { input: ["text"], output: ["image"] } },
      audio: { ...chat, id: "audio", modalities: { input: ["audio"], output: ["text"] } },
    };
    const result = await createModelsDevCatalog(async () => Response.json(fixture(models))).load();
    expect(result[0]!.models.map((m) => m.modelId)).toEqual(["good"]);
  });
  it("uses wire IDs, skips malformed entries, and rejects an invalid catalog", async () => {
    const result = await createModelsDevCatalog(async () =>
      Response.json(
        fixture({
          alias: { ...chat, id: "real-wire-id" },
          bad: { ...chat, id: "" },
        }),
      ),
    ).load();
    expect(result[0]!.models.map((m) => m.modelId)).toEqual(["real-wire-id"]);
    await expect(
      createModelsDevCatalog(async () => Response.json({ error: "bad" })).load(),
    ).rejects.toThrow();
  });
  it("does not cache failures and classifies connect, HTTP and malformed-body errors without leaking details", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:7890"))
      .mockResolvedValueOnce(Response.json(fixture()));
    const port = createModelsDevCatalog(fetcher);
    const failure = await port.load().catch((error: Error) => error);
    expect((failure as Error).message).toBe("catalog-request-failed");
    expect((failure as Error).message).not.toContain("7890");
    expect(await port.load()).toHaveLength(1);
    await expect(
      createModelsDevCatalog(async () => new Response("private", { status: 503 })).load(),
    ).rejects.toThrow("catalog-invalid-response");
    await expect(
      createModelsDevCatalog(async () => new Response("<html>captive portal</html>")).load(),
    ).rejects.toThrow("catalog-invalid-response");
  });
  it("rejects oversized bodies before they can become config", async () => {
    await expect(
      createModelsDevCatalog(
        async () =>
          new Response("{}", {
            headers: { "content-length": String(17 * 1024 * 1024) },
          }),
      ).load(),
    ).rejects.toThrow("catalog-response-too-large");
  });
  it("requests a 20 second timeout and reports it as a timeout without partial data", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    try {
      const fetcher: typeof fetch = async (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), {
            once: true,
          });
        });
      const loading = createModelsDevCatalog(fetcher).load();
      const rejected = expect(loading).rejects.toThrow("catalog-timeout");
      expect(timeout).toHaveBeenCalledWith(20_000);
      controller.abort(new DOMException("timed out", "TimeoutError"));
      await rejected;
    } finally {
      timeout.mockRestore();
    }
  });
  it("bounds streamed bodies even when the server omits Content-Length", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16 * 1024 * 1024));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    await expect(createModelsDevCatalog(async () => new Response(body)).load()).rejects.toThrow(
      "catalog-response-too-large",
    );
  });
  it("reports a timeout while the body is still streaming as a timeout", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    try {
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new TextEncoder().encode("{"));
          controller.signal.addEventListener("abort", () => stream.error(controller.signal.reason));
        },
      });
      const loading = createModelsDevCatalog(async () => new Response(body)).load();
      const rejected = expect(loading).rejects.toThrow("catalog-timeout");
      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.abort(new DOMException("timed out", "TimeoutError"));
      await rejected;
    } finally {
      timeout.mockRestore();
    }
  });
});

const entry = (modelId: string, contextWindow: number, extra: Record<string, unknown> = {}) => ({
  modelId,
  config: {
    properties: { contextWindow, supportsToolCall: true, ...extra },
    optionSpecs: { maxOutputTokens: { max: 8192 } },
  },
});
const provider = (
  sourceId: string,
  models: ModelCatalogProvider["models"],
): ModelCatalogProvider => ({
  sourceId,
  name: sourceId,
  models,
});

describe("catalog matching by model name", () => {
  it("matches gateway names across catalog suppliers and returns the original local IDs", () => {
    const ids = [
      "aliyun/deepseek-v4.1-flash",
      "aliyun/kimi-k3.1-pro",
      "aliyun/qwen4-max",
      "aliyun/qwen3.8-max-0902",
      "gpt-luna-latest",
      "opencode/glm-5.3-flash",
      "opencode/mimo-v2.6-flash",
    ];
    const result = matchModelCatalog(ids, [
      provider("alibaba-cn", [
        entry("deepseek-v4-1-flash", 100),
        entry("kimi-k3.1-pro", 200),
        entry("qwen4-max", 300),
      ]),
      provider("vercel", [entry("Qwen/Qwen3.8_Max 0902", 400)]),
      provider("opencode-go", [entry("GLM-5.3--Flash", 500), entry("mimo-v2.6-flash", 600)]),
      provider("openrouter", [entry("~openai/gpt-luna-latest", 700)]),
    ]);

    expect([...result.matches.keys()]).toEqual(ids);
    expect(ids.map((id) => result.matches.get(id)?.values.contextWindow)).toEqual([
      100, 200, 300, 400, 700, 500, 600,
    ]);
    expect(result.notFoundModelIds).toEqual([]);
  });

  it("recognizes built-in Claude spellings without dropping version, date or variant suffixes", () => {
    const equivalents = ["haiku-4.5", "opus-4.8", "fable-5.1", "mythos-5.1"];
    const missing = [
      "qwen3.8-max-0902",
      "mimo-v2.6-flash",
      "deepseek-v4.1-flash",
      "claude-fable-5",
    ];
    const result = matchModelCatalog(
      [...equivalents.map((id) => `gateway/claude-${id}`), ...missing],
      [
        provider("example", [
          ...equivalents.map((id) => entry(`anthropic/Claude-${id.replace(".", "-")}`, 100)),
          entry("qwen3.8-max-0912", 200),
          entry("mimo-v2.6-pro", 300),
          entry("mimo-v2.6-flash-free", 400),
          entry("deepseek-v4.1-flash-1017", 500),
        ]),
      ],
    );
    expect(result.matches.size).toBe(equivalents.length);
    expect(result.notFoundModelIds).toEqual(missing);
  });

  it("votes per field across all sources, deduplicates votes and skips conflicting or absent votes", () => {
    const a = entry("original/test-model", 100, { supportsToolCall: false });
    const b = entry("other/Test_Model", 200);
    const result = matchModelCatalog(
      ["gateway/test-model"],
      [
        provider("alpha", [
          a,
          { ...a, modelId: "alias/TEST-MODEL" },
          { ...a, modelId: "Test-Model" },
        ]),
        provider("beta", [b]),
        provider("gamma", [b]),
        provider("ambiguous", [a, b]),
        provider("missing", [{ modelId: "test-model", config: {} }]),
      ],
    );
    expect(result.matches.get("gateway/test-model")).toEqual({
      values: { contextWindow: 200, maxOutputTokens: 8192, supportsToolCall: true },
      conflictingFields: [],
    });
  });

  it("reports tied and internally conflicting fields while using other values", () => {
    const result = matchModelCatalog(
      ["gateway/test-model", "unknown"],
      [
        provider("alpha", [entry("alias/test-model", 100, { supportsJsonSchemaOutput: true })]),
        provider("beta", [entry("test-model", 200)]),
        provider("gamma", [
          {
            modelId: "test-model",
            config: { properties: { inputFormat: { supportsImage: true } } },
          },
          {
            modelId: "elsewhere/Test-Model",
            config: { properties: { inputFormat: { supportsImage: false } } },
          },
        ]),
      ],
    );
    expect(result.matches.get("gateway/test-model")).toEqual({
      values: { maxOutputTokens: 8192, supportsToolCall: true, supportsJsonSchemaOutput: true },
      conflictingFields: ["contextWindow", "inputImage"],
    });
    expect(result.notFoundModelIds).toEqual(["unknown"]);
  });
});

describe("reasoning levels come only from the catalog", () => {
  const load = async (model: Record<string, unknown>) =>
    (
      await createModelsDevCatalog(async () =>
        Response.json(fixture({ "future-chat": { ...chat, ...model } })),
      ).load()
    )[0]!.models[0]!.reasoning;
  it("uses effort values verbatim and adds the off level only when the catalog has a toggle", async () => {
    expect(
      await load({
        reasoning_options: [{ type: "effort", values: ["minimal", "low", "medium", "high"] }],
      }),
    ).toEqual({ toggle: false, budget: false, levels: ["minimal", "low", "medium", "high"] });
    expect(
      await load({
        reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
      }),
    ).toEqual({ toggle: true, budget: false, levels: ["disabled", "low", "high", "max"] });
    expect(
      await load({
        reasoning_options: [
          { type: "toggle" },
          { type: "effort", values: ["none", "low", "high"] },
        ],
      }),
    ).toMatchObject({ levels: ["none", "low", "high"] });
  });
  it("never fabricates levels for toggle-only, budget-only, empty or non-reasoning models", async () => {
    expect(await load({ reasoning_options: [{ type: "toggle" }] })).toEqual({
      toggle: true,
      budget: false,
    });
    expect(
      await load({ reasoning_options: [{ type: "budget_tokens", min: 1024, max: 32768 }] }),
    ).toEqual({ toggle: false, budget: true });
    expect(await load({ reasoning_options: [] })).toEqual({ toggle: false, budget: false });
    expect(await load({ reasoning_options: undefined })).toEqual({ toggle: false, budget: false });
    expect(await load({ reasoning: false })).toBeUndefined();
  });
  it("reports why levels were not written instead of guessing", () => {
    const source = (models: ModelCatalogProvider["models"]) => [
      { sourceId: "s", name: "S", models },
    ];
    const base = { config: { properties: { contextWindow: 1 } } };
    const gap = (reasoning: Record<string, unknown>) =>
      matchModelCatalog(
        ["m"],
        source([{ modelId: "m", ...base, reasoning: reasoning as never }]),
      ).matches.get("m")!.reasoningGap;
    expect(gap({ toggle: false, budget: false })).toBe("no-levels");
    expect(gap({ toggle: false, budget: true })).toBe("budget-only");
    // 只有开关与默认“关闭/开启”一致：不报缺口，也不改动已有的多档配置。
    expect(gap({ toggle: true, budget: false })).toBeUndefined();
  });

  it("takes the first explicit multi-level list when sources disagree", () => {
    const match = matchModelCatalog(
      ["m"],
      [
        {
          sourceId: "a",
          name: "A",
          models: [
            {
              modelId: "m",
              config: {},
              reasoning: { toggle: true, budget: false, levels: ["none", "high"] },
            },
          ],
        },
        {
          sourceId: "b",
          name: "B",
          models: [
            {
              modelId: "m",
              config: {},
              reasoning: { toggle: true, budget: false, levels: ["none", "low", "medium", "high"] },
            },
          ],
        },
        provider("c", [
          {
            modelId: "m",
            config: {},
            reasoning: { toggle: false, budget: false, levels: ["low", "high", "max"] },
          },
        ]),
      ],
    ).matches.get("m")!;
    expect(match.values.reasoningLevels).toEqual(["none", "low", "medium", "high"]);
    expect(match.conflictingFields).toEqual([]);
    expect(match.reasoningGap).toBeUndefined();
  });

  it("still uses an explicit single-level list when it is the only list available", () => {
    const match = matchModelCatalog(
      ["m"],
      [
        provider("s", [
          {
            modelId: "m",
            config: {},
            reasoning: { toggle: false, budget: false, levels: ["high"] },
          },
        ]),
      ],
    ).matches.get("m")!;
    expect(match.values.reasoningLevels).toEqual(["high"]);
    expect(match.reasoningGap).toBeUndefined();
  });
});

describe("catalog-managed field ownership", () => {
  it("never overwrites a user-set field and skips values already effective", () => {
    const { patch, record } = planManagedCatalogPatch({
      catalog: {
        contextWindow: 128000,
        maxOutputTokens: 16384,
        supportsToolCall: true,
        inputImage: true,
      },
      personalConfig: { properties: { contextWindow: 32000 } },
      effectiveConfig: {
        properties: {
          contextWindow: 32000,
          supportsToolCall: true,
          inputFormat: { supportsImage: false },
        },
      },
      recorded: undefined,
    });
    expect(patch).toEqual({ maxOutputTokens: 16384, inputImage: true });
    expect(record).toEqual(patch);
  });
  it("treats an explicit false set by the user as user-set", () => {
    const { patch, record } = planManagedCatalogPatch({
      catalog: { supportsToolCall: true },
      personalConfig: { properties: { supportsToolCall: false } },
      effectiveConfig: { properties: { supportsToolCall: false } },
      recorded: undefined,
    });
    expect(patch).toEqual({});
    expect(record).toEqual({});
  });
  it("refreshes recorded fields still holding the last written value, including reasoning levels", () => {
    const { patch, record } = planManagedCatalogPatch({
      catalog: { contextWindow: 200000, reasoningLevels: ["low", "medium", "high", "xhigh"] },
      personalConfig: {
        properties: { contextWindow: 128000 },
        optionSpecs: { reasoningLevel: { values: ["low", "high"] } },
      },
      effectiveConfig: {},
      recorded: { contextWindow: 128000, reasoningLevels: ["low", "high"] },
    });
    expect(patch).toEqual({
      contextWindow: 200000,
      reasoningLevels: ["low", "medium", "high", "xhigh"],
    });
    expect(record).toEqual(patch);
  });
  it("hands a recorded field to the user once edited and keeps unchanged managed fields", () => {
    const { patch, record } = planManagedCatalogPatch({
      catalog: { contextWindow: 200000, maxOutputTokens: 32000, reasoningLevels: ["low", "high"] },
      personalConfig: {
        properties: { contextWindow: 64000 },
        optionSpecs: { maxOutputTokens: { max: 16384 }, reasoningLevel: { values: ["low"] } },
      },
      effectiveConfig: {},
      recorded: { contextWindow: 128000, maxOutputTokens: 16384, reasoningLevels: ["low", "high"] },
    });
    // 上下文与推理档位被用户改过 → 不写且退出记录；最大输出仍是上次写入值 → 刷新。
    expect(patch).toEqual({ maxOutputTokens: 32000 });
    expect(record).toEqual({ maxOutputTokens: 32000 });
  });
  it("keeps a managed value when the catalog no longer provides it", () => {
    const { patch, record } = planManagedCatalogPatch({
      catalog: {},
      personalConfig: { properties: { contextWindow: 128000 } },
      effectiveConfig: {},
      recorded: { contextWindow: 128000 },
    });
    expect(patch).toEqual({});
    expect(record).toEqual({ contextWindow: 128000 });
  });
});
