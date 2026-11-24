import { z } from "zod";
import {
  parseModelConfig,
  type ModelCatalogEntry,
  type ModelCatalogProvider,
  type ModelCatalogReasoning,
} from "@zcode/provider";

const MAX_BYTES = 16 * 1024 * 1024;
const positiveLimit = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional();
const modelSchema = z.object({
  id: z.string().trim().min(1).max(512),
  type: z.string().optional(),
  family: z.string().optional(),
  status: z.string().optional(),
  tool_call: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  reasoning_options: z
    .array(z.object({ type: z.string(), values: z.array(z.string()).optional() }).passthrough())
    .optional()
    .catch(undefined),
  structured_output: z.boolean().optional(),
  modalities: z.object({ input: z.array(z.string()), output: z.array(z.string()) }),
  limit: z.object({ context: positiveLimit, output: positiveLimit }).optional(),
});
const sourceSchema = z.object({
  name: z.string().min(1),
  models: z.record(z.string(), z.unknown()),
});

function toEntry(value: unknown): ModelCatalogEntry | null {
  const parsed = modelSchema.safeParse(value);
  if (!parsed.success) return null;
  const model = parsed.data;
  const kind = `${model.type ?? ""} ${model.family ?? ""} ${model.id}`;
  if (
    /embed|rerank|moderation/i.test(kind) ||
    /^(deprecated|retired|removed)$/i.test(model.status ?? "")
  )
    return null;
  if (!model.modalities.input.includes("text") || !model.modalities.output.includes("text"))
    return null;
  const modalities = new Set(model.modalities.input);
  const config = parseModelConfig({
    properties: {
      ...(model.limit?.context ? { contextWindow: model.limit.context } : {}),
      ...(model.tool_call !== undefined ? { supportsToolCall: model.tool_call } : {}),
      ...(model.structured_output !== undefined
        ? { supportsJsonSchemaOutput: model.structured_output }
        : {}),
      inputFormat: {
        supportsText: true,
        supportsImage: modalities.has("image"),
        supportsAudio: modalities.has("audio"),
        supportsVideo: modalities.has("video"),
        supportsPdf: modalities.has("pdf"),
      },
      outputFormat: { supportsText: true },
    },
    ...(model.limit?.output
      ? { optionSpecs: { maxOutputTokens: { max: model.limit.output } } }
      : {}),
  });
  return { modelId: model.id, config: config.toJSON(), reasoning: toReasoning(model) };
}

/**
 * OpenZWork(OZ-F015): 只采用 models.dev 明确给出的档位名（`reasoning_options[type=effort].values`）。
 * 同时声明 toggle 且档位里没有 none/disabled 时，在最前补上本仓库的关闭档 `disabled`（toggle 即“可关闭”）。
 * 只有 toggle、只有 budget_tokens 范围、或 reasoning=true 但没有选项时都不生成档位。
 */
function toReasoning(model: z.infer<typeof modelSchema>): ModelCatalogReasoning | undefined {
  if (!model.reasoning) return undefined;
  const options = model.reasoning_options ?? [];
  const toggle = options.some((option) => option.type === "toggle");
  const budget = options.some((option) => option.type === "budget_tokens");
  const effort = options.find((option) => option.type === "effort" && option.values?.length);
  if (!effort?.values) return { toggle, budget };
  const levels = [
    ...new Set(effort.values.map((value) => value.trim()).filter((value) => value.length > 0)),
  ];
  if (!levels.length) return { toggle, budget };
  const withOff =
    toggle && !levels.includes("none") && !levels.includes("disabled")
      ? ["disabled", ...levels]
      : levels;
  return { toggle, budget, levels: withOff };
}

function parseCatalog(value: unknown): readonly ModelCatalogProvider[] {
  const root = z.record(z.string(), z.unknown()).parse(value);
  const result: ModelCatalogProvider[] = [];
  for (const [sourceId, raw] of Object.entries(root)) {
    const parsed = sourceSchema.safeParse(raw);
    if (!parsed.success || !sourceId.trim()) continue;
    const models = new Map<string, ModelCatalogEntry>();
    for (const rawModel of Object.values(parsed.data.models)) {
      const entry = toEntry(rawModel);
      if (entry) models.set(entry.modelId, entry);
    }
    if (models.size)
      result.push({
        sourceId,
        name: parsed.data.name,
        models: [...models.values()].sort((a, b) => a.modelId.localeCompare(b.modelId)),
      });
  }
  if (!result.length) throw new Error("catalog-invalid-response");
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

async function readCatalogBody(response: Response): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > MAX_BYTES) {
    await response.body?.cancel();
    throw new Error("catalog-response-too-large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("catalog-invalid-response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error("catalog-response-too-large");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * OpenZWork(OZ-F015): 目录失败只暴露三类稳定错误码，UI 据此给出“连不上 / 超时 / 返回异常”文案：
 * - catalog-timeout：20 秒总超时（连接或读取 body 期间）。
 * - catalog-invalid-response：已收到响应但 HTTP 非 2xx、超出体积上限、不是合法 JSON 或没有可用模型。
 * - catalog-request-failed：其它网络失败（DNS、拒绝连接、代理/证书错误等）。
 * 原始错误细节（可能含代理地址）不外泄。
 */
export type ModelCatalogErrorCode =
  | "catalog-timeout"
  | "catalog-invalid-response"
  | "catalog-response-too-large"
  | "catalog-request-failed";

function isTimeout(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted && (signal.reason as { name?: unknown } | undefined)?.name === "TimeoutError")
    return true;
  return error instanceof Error && error.name === "TimeoutError";
}

/** OpenZWork(OZ-F015): 手动补全用固定公开目录，不注入任何 Provider 连接或凭据。 */
export function createModelsDevCatalog(fetcher: typeof fetch = fetch): {
  load(): Promise<readonly ModelCatalogProvider[]>;
} {
  return {
    async load() {
      const signal = AbortSignal.timeout(20_000);
      let response: Response;
      try {
        response = await fetcher("https://models.dev/api.json", {
          signal,
          redirect: "error",
          credentials: "omit",
          headers: { Accept: "application/json" },
        });
      } catch (error) {
        throw new Error(isTimeout(error, signal) ? "catalog-timeout" : "catalog-request-failed");
      }
      try {
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new Error("catalog-invalid-response");
        }
        return parseCatalog(await readCatalogBody(response));
      } catch (error) {
        if (isTimeout(error, signal)) throw new Error("catalog-timeout");
        if (error instanceof Error && error.message === "catalog-response-too-large") throw error;
        throw new Error("catalog-invalid-response");
      }
    },
  };
}
