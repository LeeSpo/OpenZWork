import type { ModelConfigObject, ModelId } from "../config/index.js";
import type {
  CatalogManagedModelFields,
  ModelCatalogEntry,
  ModelCatalogField,
  ModelCatalogMatch,
  ModelCatalogMatchResult,
  ModelCatalogProvider,
  ModelCatalogReasoning,
  ModelCatalogReasoningGap,
  ModelCatalogValue,
  ModelCatalogValues,
} from "./model-catalog-update.js";

/**
 * 按已添加模型的名称匹配公开目录，选出资料和推理档位并规划个人配置补丁。
 * 不增删模型、不改用户已改字段、不写内置目录文件。
 * matchModelCatalog / planManagedCatalogPatch 都是纯函数，无 IO，可重复调用。
 */
export interface ModelCatalogUpdateContract {
  matchModelCatalog(
    existingModelIds: readonly ModelId[],
    catalog: readonly ModelCatalogProvider[],
  ): ModelCatalogMatchResult;
  planManagedCatalogPatch(input: {
    readonly catalog: ModelCatalogValues;
    readonly personalConfig: ModelConfigObject | undefined;
    readonly effectiveConfig: ModelConfigObject;
    readonly recorded: ModelCatalogValues | undefined;
  }): { readonly patch: ModelCatalogValues; readonly record: ModelCatalogValues };
}

export type {
  CatalogManagedModelFields,
  ModelCatalogEntry,
  ModelCatalogField,
  ModelCatalogMatch,
  ModelCatalogMatchResult,
  ModelCatalogProvider,
  ModelCatalogReasoning,
  ModelCatalogReasoningGap,
  ModelCatalogValue,
  ModelCatalogValues,
};
