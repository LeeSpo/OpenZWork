import type { ProviderModelDiscoveryDialogProps } from "./contract.js";
export const discoveryExample: Pick<
  ProviderModelDiscoveryDialogProps,
  "providerId" | "open" | "models"
> = {
  providerId: "example",
  open: false,
  models: [],
};

export const catalogUpdateExample: import("./contract.js").ModelCatalogUpdateButtonProps = {
  providerId: "example",
  providerName: "My provider",
};
