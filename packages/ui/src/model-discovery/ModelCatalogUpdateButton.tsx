import { useState } from "react";
import { RefreshCw } from "lucide-react";
import type { ModelCatalogField, ModelCatalogFieldReport } from "@zcode/provider";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog.js";
import { useModelCatalogUpdate } from "./useModelCatalogUpdate.js";

import type { ModelCatalogUpdateButtonProps as Props } from "./contract.js";

/**
 * OpenZWork(OZ-F015): 模型列表旁的一键入口。服务按模型名称匹配目录并保存个人配置，弹窗展示结果。
 */
export function ModelCatalogUpdateButton({ providerId, providerName, onUpdate }: Props) {
  const { intl } = useZCodeIntl();
  const t = (key: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id: `settings.modelProvider.catalog.${key}` }, values);
  const [open, setOpen] = useState(false);
  const query = useModelCatalogUpdate(providerId, onUpdate);
  const result = query.result;
  const fieldLabel = (field: ModelCatalogField) => t(`field.${field}`);
  const levelsText = (levels: readonly string[]) =>
    levels.length
      ? t("reasoningLevels", { count: levels.length, names: levels.join(" / ") })
      : t("reasoningLevelsNone");
  const list = (key: string, ids: readonly string[], testId: string) =>
    ids.length ? (
      <li data-testid={testId}>
        {t(key, { count: ids.length })}
        {": "}
        <span className="break-all font-mono text-ui-sm">{ids.join(", ")}</span>
      </li>
    ) : null;
  const fieldList = (key: string, models: readonly ModelCatalogFieldReport[], testId: string) => (
    <div data-testid={testId}>
      <p>{t(key, { count: models.length })}</p>
      <ul className="list-disc pl-5 text-ui-sm">
        {models.map(({ modelId, fields }) => (
          <li key={modelId}>
            <span className="break-all font-mono">{modelId}</span>
            {" · "}
            {fields.map(fieldLabel).join(t("fieldSeparator"))}
          </li>
        ))}
      </ul>
    </div>
  );
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={query.updating}
        onClick={() => {
          setOpen(true);
          void query.run();
        }}
        data-testid="model-catalog-update-open"
      >
        <RefreshCw
          className={query.updating ? "animate-spin" : undefined}
          data-icon="inline-start"
          aria-hidden="true"
        />
        {t("title")}
      </Button>
      {open ? (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next && !query.updating) {
              setOpen(false);
              query.reset();
            }
          }}
        >
          <DialogContent
            className="max-w-lg"
            data-testid="model-catalog-update-dialog"
            aria-busy={query.updating}
          >
            <DialogHeader>
              <DialogTitle>{t("title")}</DialogTitle>
              <DialogDescription>
                {t("description", { provider: providerName || providerId })}
              </DialogDescription>
            </DialogHeader>
            {query.updating ? (
              <p role="status" className="text-ui-base">
                {t("updating")}
              </p>
            ) : null}
            {query.error ? (
              <p role="alert" className="text-ui-base text-destructive">
                {t(`error.${query.error}`)}
              </p>
            ) : null}
            {result ? (
              <div
                role="status"
                className="space-y-2 text-ui-base"
                data-testid="model-catalog-result"
              >
                <p className="text-ui-sm text-foreground-subtle">
                  {result.matchedModelCount > 0
                    ? t("matched", { count: result.matchedModelCount })
                    : t("matchedNone")}
                </p>
                {result.updated.length ? (
                  fieldList("updated", result.updated, "model-catalog-updated")
                ) : (
                  <p data-testid="model-catalog-nothing-updated">{t("nothingUpdated")}</p>
                )}
                {result.conflictingFields.length
                  ? fieldList("conflicting", result.conflictingFields, "model-catalog-conflicting")
                  : null}
                {result.reasoningChanged.length ? (
                  <div data-testid="model-catalog-reasoning-changed">
                    <p>{t("reasoningChanged", { count: result.reasoningChanged.length })}</p>
                    <ul className="list-disc pl-5 text-ui-sm">
                      {result.reasoningChanged.map((change) => (
                        <li key={change.modelId}>
                          <span className="break-all font-mono">{change.modelId}</span>
                          {": "}
                          {t("reasoningFromTo", {
                            from: levelsText(change.from),
                            to: levelsText(change.to),
                          })}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {result.reasoningUnconfigured.length ? (
                  <div data-testid="model-catalog-reasoning-unconfigured">
                    <p>
                      {t("reasoningUnconfigured", { count: result.reasoningUnconfigured.length })}
                    </p>
                    <ul className="list-disc pl-5 text-ui-sm text-foreground-subtle">
                      {result.reasoningUnconfigured.map((gap) => (
                        <li key={gap.modelId}>
                          <span className="break-all font-mono">{gap.modelId}</span>
                          {": "}
                          {t(`reasoningGap.${gap.reason}`)}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <ul className="space-y-1 text-ui-sm text-foreground-subtle">
                  {list("upToDate", result.upToDateModelIds, "model-catalog-up-to-date")}
                  {list("manual", result.manualModelIds, "model-catalog-manual")}
                  {list("notFound", result.notFoundModelIds, "model-catalog-not-found")}
                </ul>
                <p className="text-ui-sm text-foreground-subtle">{t("preserve")}</p>
              </div>
            ) : null}
            <DialogFooter>
              {query.error ? (
                <Button
                  variant="outline"
                  onClick={() => void query.run()}
                  data-testid="model-catalog-update-retry"
                >
                  {t("retry")}
                </Button>
              ) : null}
              <Button
                disabled={query.updating}
                onClick={() => {
                  setOpen(false);
                  query.reset();
                }}
                data-testid="model-catalog-update-close"
              >
                {t("close")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
