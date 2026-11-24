import type { ProviderModelDiscoveryContract } from "./contract.js";
export function readModels(adapter: ProviderModelDiscoveryContract) {
  return adapter.discover({ api: { type: "openai-responses", baseUrl: "https://example.com/v1" } });
}

/** OpenZWork(OZ-F015): 公开目录不接受 Provider 配置参数。 */
export const catalogReadExample = async () => {
  const { createModelsDevCatalog } = await import("./index.js");
  return createModelsDevCatalog().load();
};
