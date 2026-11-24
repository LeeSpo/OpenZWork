# 模型列表读取

输入是所属 Environment 已保存的有效 Provider 配置。只 GET 同源 models 端点，不保存配置、不执行推理、不写日志；返回规范化模型 ID 或枚举错误。禁用重定向，限制总请求时间、分页、响应体与模型条数。自定义 headers 沿既有配置应用，凭据不进入返回值。保存与 Registry 更新仍由 Provider Settings 完成。

目录请求策略由本 adapter 独占。通用 Messages 连接沿用鉴权，首次不自动添加 `anthropic-version`；官方 Anthropic 和用户显式版本头保持原生方式。仅通用连接首个 HTTP 400/401/403/404/405 响应允许同源补版本头重查一次，与分页共享总超时。成功空列表、限流、服务端错误、非法响应及分页中途失败不切换策略。返回 ID 不做网关特定解码，后续推理协议与持久化配置不变。

## OpenZWork(OZ-F015)：公开目录补全已有模型资料

`createModelsDevCatalog(fetcher).load()` 无连接/凭据输入，仅拉取固定 models.dev JSON；20 秒总超时、16 MiB 限制、拒绝重定向。正式运行时 `fetcher` 是 Host API 网络出口，沿用应用的代理、No Proxy 和自定义 CA。输出去重后的文本对话模型元数据和推理事实（`reasoning: {toggle, budget, levels?}`，档位只来自 `effort.values`，有 toggle 时补 `disabled`），不生成请求参数映射、不保存配置。每次显式调用重新读取，不缓存失败。

失败只抛固定错误码，不外泄原始细节（可能含代理地址）：

| 错误码                       | 含义                                                   |
| ---------------------------- | ------------------------------------------------------ |
| `catalog-timeout`            | 连接或读取 body 超过 20 秒                             |
| `catalog-request-failed`     | 连不上：DNS、拒绝连接、代理或证书错误等                |
| `catalog-invalid-response`   | 已收到响应但 HTTP 非 2xx、不是合法 JSON 或没有可用模型 |
| `catalog-response-too-large` | 响应超过 16 MiB（UI 按“返回异常”处理）                 |

匹配由 `@zcode/provider` 的 `matchModelCatalog` 执行。按规范化的模型名称查找全目录，再逐字段取过半值。每个供应商每个字段只投一票，缺值和内部冲突弃权。返回结果使用原始模型 ID，并报告未找到的模型及未取得过半票的字段。

可写字段固定为上下文窗口、最大输出、工具调用、结构化输出，文本/图片/音频/视频/PDF 输入和文本输出，以及推理档位列表。资料逐字段取过半值，档位优先采用首个明确的多档列表。

写入归属（`planManagedCatalogPatch`，在 ConfigService 事务内执行）：个人配置 `catalogManagedFields` 记录本功能写过的字段及最后写入值，与规则同一次原子写。用户设置的字段永不改；记录字段仍等于最后写入值时可被目录刷新；用户改过的记录字段归用户并移出记录。内置继承模型同样写入 Personal 精确规则，内置文件不变。
