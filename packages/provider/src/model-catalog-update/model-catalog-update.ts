import type { ModelConfigObject, ModelId, ProviderId } from "../config/index.js";

// OpenZWork(OZ-F015): 公开模型目录只用来补全已有模型资料，不成为运行期能力事实源。
/** 目录给出的推理信息；levels 只来自 models.dev 明确列出的档位名。 */
export interface ModelCatalogReasoning {
  readonly toggle: boolean;
  readonly budget: boolean;
  readonly levels?: readonly string[];
}
export interface ModelCatalogEntry {
  readonly modelId: ModelId;
  readonly config: ModelConfigObject;
  readonly reasoning?: ModelCatalogReasoning;
}
export interface ModelCatalogProvider {
  readonly sourceId: string;
  readonly name: string;
  readonly models: readonly ModelCatalogEntry[];
}

/** 目录可补全的固定叶子；enabled、推理映射表达式等其它字段永远不来自目录。 */
export const MODEL_CATALOG_FIELDS = [
  "contextWindow",
  "maxOutputTokens",
  "supportsToolCall",
  "supportsJsonSchemaOutput",
  "inputText",
  "inputImage",
  "inputAudio",
  "inputVideo",
  "inputPdf",
  "outputText",
  "reasoningLevels",
] as const;
export type ModelCatalogField = (typeof MODEL_CATALOG_FIELDS)[number];
export type ModelCatalogValue = number | boolean | readonly string[];
export type ModelCatalogValues = Partial<Record<ModelCatalogField, ModelCatalogValue>>;

const FIELD_PATHS: Record<ModelCatalogField, readonly string[]> = {
  contextWindow: ["properties", "contextWindow"],
  maxOutputTokens: ["optionSpecs", "maxOutputTokens", "max"],
  supportsToolCall: ["properties", "supportsToolCall"],
  supportsJsonSchemaOutput: ["properties", "supportsJsonSchemaOutput"],
  inputText: ["properties", "inputFormat", "supportsText"],
  inputImage: ["properties", "inputFormat", "supportsImage"],
  inputAudio: ["properties", "inputFormat", "supportsAudio"],
  inputVideo: ["properties", "inputFormat", "supportsVideo"],
  inputPdf: ["properties", "inputFormat", "supportsPdf"],
  outputText: ["properties", "outputFormat", "supportsText"],
  reasoningLevels: ["optionSpecs", "reasoningLevel", "values"],
};

export function sameModelCatalogValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => value === right[index])
    );
  }
  return left === right;
}

function isCatalogValue(value: unknown): value is ModelCatalogValue {
  return (
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}

/** 读取一份配置中的目录叶子；null/undefined 视为未设置，其余值都算“已设置”。 */
export function readModelCatalogField(
  config: ModelConfigObject | undefined,
  field: ModelCatalogField,
): ModelCatalogValue | undefined {
  let value: unknown = config;
  for (const key of FIELD_PATHS[field]) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return isCatalogValue(value) ? value : undefined;
}

export function readModelCatalogValues(entry: ModelCatalogEntry): ModelCatalogValues {
  const values: ModelCatalogValues = {};
  for (const field of MODEL_CATALOG_FIELDS) {
    if (field === "reasoningLevels") continue;
    const value = readModelCatalogField(entry.config, field);
    if (value !== undefined) values[field] = value;
  }
  if (entry.reasoning?.levels?.length) values.reasoningLevels = [...entry.reasoning.levels];
  return values;
}

/** 把目录叶子写回 ModelConfigObject 形状，供 overlay 使用。 */
export function modelCatalogValuesToConfig(values: ModelCatalogValues): ModelConfigObject {
  const root: Record<string, unknown> = {};
  for (const field of MODEL_CATALOG_FIELDS) {
    const value = values[field];
    if (value === undefined) continue;
    const path = FIELD_PATHS[field];
    let node = root;
    for (const key of path.slice(0, -1)) {
      node = (node[key] ??= {}) as Record<string, unknown>;
    }
    node[path[path.length - 1]!] = Array.isArray(value) ? [...value] : value;
  }
  return root as ModelConfigObject;
}

/** 目录说支持推理、但无法写入档位的原因。 */
export type ModelCatalogReasoningGap = "no-levels" | "budget-only";

export interface ModelCatalogMatch {
  readonly values: ModelCatalogValues;
  /** 目录给出了值，但该字段没有过半结果。 */
  readonly conflictingFields: readonly ModelCatalogField[];
  readonly reasoningGap?: ModelCatalogReasoningGap;
}

export interface ModelCatalogMatchResult {
  /** 按原始模型 ID 返回，包含找到了名称但没有可写字段的模型。 */
  readonly matches: ReadonlyMap<ModelId, ModelCatalogMatch>;
  readonly notFoundModelIds: readonly ModelId[];
}

function catalogModelName(modelId: ModelId): string {
  const name = modelId
    .slice(modelId.lastIndexOf("/") + 1)
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "-");
  // 借鉴内置 modelMatch 中已明确等价的版本写法，仅合并整个型号，避免家族规则混入不同变体。
  return name
    .replace(/^deepseek-v4-1-flash$/, "deepseek-v4.1-flash")
    .replace(/^(claude-haiku-4)-5$/, "$1.5")
    .replace(/^(claude-opus-4)-8$/, "$1.8")
    .replace(/^(claude-(?:fable|mythos)-5)-1$/, "$1.1");
}

function reasoningGapOf(
  entries: readonly ModelCatalogEntry[],
): ModelCatalogReasoningGap | undefined {
  const reasoning = entries.flatMap((entry) => (entry.reasoning ? [entry.reasoning] : []));
  if (reasoning.some((item) => item.budget)) return "budget-only";
  // 只有开关：与默认“关闭/开启”一致，不算缺口，也不降级已有多档配置。
  if (reasoning.some((item) => !item.toggle)) return "no-levels";
  return undefined;
}

const REASONING_SWITCH_LEVELS = new Set(["none", "disabled", "off", "enabled", "on"]);

function hasMultipleReasoningEfforts(levels: readonly string[]): boolean {
  const strengths = new Set(levels.map((level) => level.toLowerCase()));
  for (const level of REASONING_SWITCH_LEVELS) strengths.delete(level);
  return strengths.size >= 2;
}

function majorityMatch(sources: readonly (readonly ModelCatalogEntry[])[]): ModelCatalogMatch {
  const sourceValues = sources.map((entries) => entries.map(readModelCatalogValues));
  const values: ModelCatalogValues = {};
  const conflictingFields: ModelCatalogField[] = [];

  for (const field of MODEL_CATALOG_FIELDS) {
    if (field === "reasoningLevels") continue;
    const votes = new Map<string, { value: ModelCatalogValue; count: number }>();
    let totalVotes = 0;
    let hasValue = false;

    for (const entries of sourceValues) {
      const declared = entries.map((entry) => entry[field]).filter((value) => value !== undefined);
      const first = declared[0];
      if (first === undefined) continue;
      hasValue = true;
      // 同一来源的别名只算一票，内部冲突时该来源弃权。
      if (!declared.every((value) => sameModelCatalogValue(first, value))) continue;
      const key = JSON.stringify(first);
      const vote = votes.get(key);
      if (vote) vote.count += 1;
      else votes.set(key, { value: first, count: 1 });
      totalVotes += 1;
    }

    const winner = [...votes.values()].find((vote) => vote.count * 2 > totalVotes);
    if (winner) values[field] = winner.value;
    else if (hasValue) conflictingFields.push(field);
  }

  const entries = sources.flat();
  const availableLevels = entries.flatMap(({ reasoning }) =>
    reasoning?.levels?.length ? [reasoning.levels] : [],
  );
  // 同名条目能明确列出多档就启用该列表，避免因供应商使用不同的档位组合而继续只显示开关。
  const reasoningLevels = availableLevels.find(hasMultipleReasoningEfforts) ?? availableLevels[0];
  if (reasoningLevels) values.reasoningLevels = [...reasoningLevels];
  const reasoningGap = reasoningLevels ? undefined : reasoningGapOf(entries);
  return { values, conflictingFields, ...(reasoningGap ? { reasoningGap } : {}) };
}

export function matchModelCatalog(
  existingModelIds: readonly ModelId[],
  catalog: readonly ModelCatalogProvider[],
): ModelCatalogMatchResult {
  const namesById = new Map(existingModelIds.map((id) => [id, catalogModelName(id)] as const));
  const entriesByName = new Map<string, Map<string, ModelCatalogEntry[]>>();
  for (const name of namesById.values()) {
    if (name) entriesByName.set(name, new Map());
  }
  for (const source of catalog) {
    for (const entry of source.models) {
      const sources = entriesByName.get(catalogModelName(entry.modelId));
      if (!sources) continue;
      const entries = sources.get(source.sourceId);
      if (entries) entries.push(entry);
      else sources.set(source.sourceId, [entry]);
    }
  }

  const matches = new Map<ModelId, ModelCatalogMatch>();
  const notFoundModelIds: ModelId[] = [];
  for (const [id, name] of namesById) {
    const sources = entriesByName.get(name);
    if (sources?.size) matches.set(id, majorityMatch([...sources.values()]));
    else notFoundModelIds.push(id);
  }
  return { matches, notFoundModelIds };
}

/** 个人配置中由“更新模型”写入的字段及最后写入值；随个人配置同一事务持久化。 */
export interface CatalogManagedModelFields {
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
  readonly fields: ModelCatalogValues;
}

/**
 * 字段归属规则（同一事务内执行）：
 * - 个人配置里有值且记录里没有 → 用户设置，永不改。
 * - 记录里有、且个人值仍等于记录值 → 目录管理：目录给出新值且与当前不同就刷新，并更新记录。
 * - 记录里有、但个人值已不同（用户改过）→ 交给用户：不改，并从记录删除；若用户清空了它，按“缺失”处理。
 * - 个人配置没有值 → 目录值与当前生效值不同时写入并记录；相同则不写。
 */
export function planManagedCatalogPatch(input: {
  readonly catalog: ModelCatalogValues;
  readonly personalConfig: ModelConfigObject | undefined;
  readonly effectiveConfig: ModelConfigObject;
  readonly recorded: ModelCatalogValues | undefined;
}): { readonly patch: ModelCatalogValues; readonly record: ModelCatalogValues } {
  const patch: ModelCatalogValues = {};
  const record: ModelCatalogValues = {};
  for (const field of MODEL_CATALOG_FIELDS) {
    const personal = readModelCatalogField(input.personalConfig, field);
    const recorded = input.recorded?.[field];
    const catalog = input.catalog[field];
    const managed = recorded !== undefined && sameModelCatalogValue(personal, recorded);
    if (personal !== undefined && !managed) continue;
    if (managed) {
      if (catalog !== undefined && !sameModelCatalogValue(catalog, personal)) {
        patch[field] = catalog;
        record[field] = catalog;
      } else {
        record[field] = recorded;
      }
      continue;
    }
    if (catalog === undefined) continue;
    if (sameModelCatalogValue(readModelCatalogField(input.effectiveConfig, field), catalog))
      continue;
    patch[field] = catalog;
    record[field] = catalog;
  }
  return { patch, record };
}
