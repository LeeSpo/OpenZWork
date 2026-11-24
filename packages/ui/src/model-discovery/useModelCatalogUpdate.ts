import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelCatalogUpdateResult } from "@zcode/provider";
import type { ModelCatalogUpdateError, ModelCatalogUpdatePort } from "./contract.js";
import { useServices } from "@/hooks/useServices.js";

interface CatalogState {
  service: ModelCatalogUpdatePort;
  providerId: string;
  updating: boolean;
  error: ModelCatalogUpdateError | null;
  result: Omit<ModelCatalogUpdateResult, "view"> | null;
}

const ERROR_CODES: readonly [string, ModelCatalogUpdateError][] = [
  ["catalog-timeout", "timeout"],
  ["catalog-invalid-response", "invalid"],
  ["catalog-response-too-large", "invalid"],
  ["catalog-request-failed", "connect"],
  ["catalog-unavailable", "connect"],
];

/** 服务端只返回稳定错误码；跨 RPC 时 message 可能带前缀，因此按包含关系识别。 */
export function classifyModelCatalogError(error: unknown): ModelCatalogUpdateError {
  const message = error instanceof Error ? error.message : String(error);
  return ERROR_CODES.find(([code]) => message.includes(code))?.[1] ?? "save";
}

/**
 * OpenZWork(OZ-F015): 由按钮点击直接触发一次补全（不在 effect 中自动执行，避免重放产生第二次写入）。
 * 只持有请求状态，配置由所属 Environment 服务发布；服务/供应商切换或关闭后丢弃迟到结果，进行中禁止重复提交。
 */
export function useModelCatalogUpdate(
  providerId: string,
  onUpdate?: ModelCatalogUpdatePort["updateModelsFromCatalog"],
) {
  const { providerSettingsService: service } = useServices();
  const [state, setState] = useState<CatalogState | null>(null);
  const generation = useRef(0);
  const running = useRef(false);
  useEffect(
    () => () => {
      generation.current += 1;
      running.current = false;
    },
    [service, providerId],
  );
  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    const current = ++generation.current;
    setState({ service, providerId, updating: true, error: null, result: null });
    try {
      const { view: _view, ...result } = await (onUpdate
        ? onUpdate(providerId)
        : service.updateModelsFromCatalog(providerId));
      if (current === generation.current)
        setState({ service, providerId, updating: false, error: null, result });
    } catch (error) {
      if (current === generation.current)
        setState({
          service,
          providerId,
          updating: false,
          error: classifyModelCatalogError(error),
          result: null,
        });
    } finally {
      if (current === generation.current) running.current = false;
    }
  }, [service, providerId, onUpdate]);
  /** 关闭弹窗：丢弃仍在途请求的反馈（写入本身由服务端单事务决定）。 */
  const reset = useCallback(() => {
    generation.current += 1;
    running.current = false;
    setState(null);
  }, []);
  const active = state?.service === service && state.providerId === providerId ? state : null;
  return {
    updating: active?.updating ?? false,
    error: active?.error ?? null,
    result: active?.result ?? null,
    run,
    reset,
  };
}
