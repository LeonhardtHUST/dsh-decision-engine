# 用 codex-auto-review 做回退审查

## 模型身份

`codex-auto-review` 是 Codex 自动审查（Auto-review，界面上叫「Approve for me」）使用的 reviewer 模型。上游 codex 的 [`select_review_model`](https://github.com/openai/codex/blob/main/codex-rs/ext/guardian-reviewer/src/model.rs) 把它作为默认 reviewer id；模型目录里该条目支持 `low` 时，审查固定用 `low` 档。官方说明见 [Auto-review](https://alignment.openai.com/auto-review/) 与 [自动审查](https://learn.chatgpt.com/docs/sandboxing/auto-review)。

它本身只是一个模型 id。DSH 没有 `approvals_reviewer` 这类开关，本插件把它当作 `guardFallback` 的审查模型调用，提示词和回答解析都由插件自己决定。

容易混的还有一处：DSH 自带的实验性 Auto review 层不读这段配置，它用当前会话的 provider 与模型，并且不传推理档位。

## 本机支持的思考档位

profile 的声明（`$DSH_HOME/profiles/desktop/cordis.patch.yml` 的 codex-proxy 路由）：

```yaml
- id: codex-auto-review
  reasoningEfforts:
    low: low
    medium: medium
    high: high
    xhigh: xhigh
    max: max
```

没有 `off`。DSH 对未声明的档位一律判为不支持，在发给模型之前就拒绝（`UNSUPPORTED_REASONING_EFFORT`），不会就近取一个可用档位，也不会自己换模型。把 `guardFallbackReasoningEffort` 写成 `off` 时提示「回退模型不支持所配置的思考档位」，来源就是这一条。

`off` 是推理档位，不是关闭自动审查的总开关。要少问，改 `tolerance`；要不参与，关 `pointAuthorize`。

档位写 `low`（与官方 guardian 一致），或者留空，表示不发送该字段、交给宿主与适配器的默认值。

## 配置示例

```yaml
guardFallback: model
guardFallbackProvider: codex-proxy
guardFallbackModel: codex-auto-review
guardFallbackReasoningEffort: low
```

`codex-proxy` 只是本机路由别名，不是判断依据。本次源码修复按 exact model id `codex-auto-review` 启用 guardian 协议，同一条路由换个名字，只要模型 id 不变，适配照样生效。档位仍按该路由声明的清单校验，换 provider 不会有人替你补上 `off`。

插件不会因为档位不兼容去改配置：它拒绝这次审查，本次调用按拒绝处理（fail-closed）。本次源码修复里，设置页对「已查到模型能力、但显式档位不在其中」给出内联警告并列出可用档位，不会静默清空或改写 provider、model、effort。

## guardian 输出协议

上游同步 reviewer 用结构化输出（[`assessment.rs`](https://github.com/openai/codex/blob/main/codex-rs/ext/guardian-reviewer/src/assessment.rs)）：

```json
{
  "risk_level": "low | medium | high | critical",
  "user_authorization": "unknown | low | medium | high",
  "outcome": "allow | deny",
  "rationale": "string"
}
```

`required` 只有 `outcome`，低风险动作可以只回 `{"outcome":"allow"}`；上游解析还接受 JSON 前后夹一段散文，并给缺失字段补默认值。

本次源码修复对 exact model id `codex-auto-review` 改用这套协议：

- 系统提示词要求只回一个 JSON 对象，允许 `outcome`，以及可选的 `risk_level`、`user_authorization`、`rationale`。
- 出现未知键、`action` 与 `outcome` 混用、代码围栏、JSON 之外的散文、数组或非法类型，都按解析失败处理。
- 其它模型继续用单键 `{"action":"allow"|"deny"}`，行为不变。

失败一律拒绝，不放行。`parse` 与 `schema` 的错误分类、deadline、`tools: []` 和 mandatory 约束都保持原样。

适配的理由：这个模型按 guardian 的提示词与 schema 调优，让它按 `{"action":...}` 回答，等于换了一套它没见过的输出契约。

## 自动批准覆盖到哪

这条链路只裁决软性 ask：模型失败、超时或回答非法时的回退审查，以及 `tolerance` 判到需要询问的那部分。

不覆盖的内容：

- mandatory 的 `deny` 与 `requires_approval`，各档都不变。
- 宿主的一次性授权（allowed-once）。模型返回 allow 不等于用户批准，不产生 native grant。
- 沙箱模式与越界写。`sandbox_permissions`、宿主拒绝、已识别的提权与破坏仍先于模型。
- 审批通道为 `never` 时没有可借用的批准通道，需要真实批准的调用照样拒绝。

所以「自动批准」指把软性询问交给模型裁决，不指绕过权限系统。

## 失败样本（脱敏）

`$DSH_HOME/dsh-decision-engine/logs/2026-11-18.log:631-632` 两行记录同一形态：`reasonCode=fallback-model-incompatible`，`failure.stage=selection`，`code=UNSUPPORTED_REASONING_EFFORT`，延迟 0 到 1 毫秒，说明请求没有到达模型。当时的 `guardFallbackReasoningEffort` 是 `off`。

`docs/audits/2026-11-17-post-release-log-audit.md` 记了同一组合的累计结果：30 次调用、0 次成功、30 次档位不支持。日志行号与统计数字取自脱敏记录，不含会话标识、用户正文或工具参数。

## 验证状态

- 本机没有任何一次成功的 `codex-auto-review` 审查记录。失败停在档位校验，不能据此判断模型不可用，也不能据此判断它可用。
- 本次源码的 guardian 协议适配只有单元测试与隔离 fixture 覆盖：解析、拒绝、档位不兼容时不发请求、失败不放行。没有对真实模型发过请求，真实回答形状、延迟和误判率都未知。
- 仓库版本与已安装版本同为 1.16.5，但本机安装早于本次修改；重新安装并重启后才带上协议适配。
- 自行验证的做法：把 effort 设为 `low` 或留空，发起一次会进入软审查的调用，再看统计里 fallback 是否出现 completed 与耗时。审查通过只代表这一次的软性询问被放行。
