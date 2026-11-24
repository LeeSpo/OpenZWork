/**
 * model-catalog-update 标准调用示例：先按已有模型 ID 匹配目录，再为可写字段规划补丁。
 */
import type { ModelConfigObject, ModelId } from "../config/index.js";
import type { ModelCatalogProvider } from "./contract.js";
import { matchModelCatalog, planManagedCatalogPatch } from "./index.js";

export function exampleModelCatalogUpdate(
  existingModelIds: readonly ModelId[],
  catalog: readonly ModelCatalogProvider[],
  personalConfig: ModelConfigObject | undefined,
  effectiveConfig: ModelConfigObject,
): void {
  const matched = matchModelCatalog(existingModelIds, catalog);
  const first = matched.matches.values().next().value;
  if (!first) return;
  planManagedCatalogPatch({
    catalog: first.values,
    personalConfig,
    effectiveConfig,
    recorded: undefined,
  });
}
