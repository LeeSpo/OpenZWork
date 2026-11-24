import type { ProviderSettingsFormModel } from "@/lib/providerSettingsFormTypes.js";

export interface ProviderModelDiscoveryDialogProps {
  providerId: string;
  providerName?: string;
  models: readonly ProviderSettingsFormModel[];
  open: boolean;
  onOpenChange(open: boolean): void;
  onAddModel(model: ProviderSettingsFormModel): Promise<void> | void;
  onConfigure(modelId: string): void;
}

/** OpenZWork(OZ-F015): UI 的最小目录端口，由当前 Environment 的服务提供。 */
export interface ModelCatalogUpdatePort {
  updateModelsFromCatalog(
    providerId: string,
  ): Promise<import("@zcode/provider").ModelCatalogUpdateResult>;
}
/** 连不上 / 超时 / 返回异常 / 保存失败；每种都意味着配置未改变。 */
export type ModelCatalogUpdateError = "connect" | "timeout" | "invalid" | "save";
export interface ModelCatalogUpdateButtonProps {
  providerId: string;
  providerName?: string;
  onUpdate?: ModelCatalogUpdatePort["updateModelsFromCatalog"];
}
