# U4 · 渠道接入（飞书 / 企业微信）

> 环节：U4（依赖 W1 hooks，已有） · 状态：文档（不改代码）
> 目标：让工单变更/巡检结果/审批推送到团队群，并支持群内事件触发工作流——复用 W1 已有 webhook 机制。
> 合规红线：仅飞书开放平台 + 企业微信官方 API；**不做个人微信号自动化**（违反使用协议、封号风险）。

---

## 1. 目标与范围

- **出站**：把内容推送到飞书/企业微信群（工单变更通知、巡检报告、审批请求）。
- **入站**：群内 @机器人 / 事件订阅 → 触发工作流或 agent 巡检（复用 `POST /api/hooks/:path`）。
- **不含**：个人微信、语音、25+ 渠道生态。仅飞书 + 企业微信两家官方 API。

---

## 2. 渠道客户端（新建 `src/core/channel/`）

零依赖，用内置 https fetch（同 aiClient/yunxiao 范式）。

### 2.1 抽象
```ts
export type ChannelKind = 'feishu' | 'wecom';
export interface ChannelClient {
  send(target: string, text: string): Promise<{ ok: boolean; error?: string }>;
}
export function getChannel(kind: ChannelKind): ChannelClient | null;
```

### 2.2 飞书（feishu.ts）
- 出站：自定义机器人 webhook（`https://open.feishu.cn/open-apis/bot/v2/hook/<token>`）发文本/富文本；或应用 tenant_access_token 发消息（更全但需应用凭证）。
- 入站：事件订阅回调 → 飞书要求 URL 校验（challenge 回显）+ 事件签名校验（Encrypt/token）。

### 2.3 企业微信（wecom.ts）
- 出站：群机器人 webhook（`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<key>`）发文本/markdown。
- 入站：应用回调（需 Token/EncodingAESKey 做 URL 验证与消息解密）。

---

## 3. 出站接入

### 3.1 工作流步骤 `notify.channel`（新建 steps/channel.ts）
- params: `{ kind: 'feishu'|'wecom'; target: string; content: string }`（content 支持 `{{表达式}}`）。
- 复用现有 notify.summary 范式；作为工作流收尾把结果推群。

### 3.2 Agent 工具 `channel_send`（capabilities/channel.ts）
- 入参 `{ kind, target, content }`；needsConfirm（外发消息属对外动作，需确认；无人值守走白名单授权）。

---

## 4. 入站接入（复用 W1 hooks）

- 飞书/企业微信事件订阅指向 `POST /api/hooks/<path>`（W1 已实现 webhook 触发与 flow.wait 唤醒）。
- U4 在 `routes/hooks.ts` 增加渠道识别与验签：
  - 飞书：URL 验证 challenge 回显；事件签名校验后，把消息体注入 `trigger.payload` 触发对应 workflow。
  - 企业微信：URL 验证 + 消息解密后同样注入 payload。
- 触发的执行沿用无人值守语义（危险步骤走批准队列，不静默）。

---

## 5. 配置（改 state + CLI）

- state.json 增 `channels`：`{ feishu?: { webhook?, appId?, appSecret?, encryptKey?, verifyToken? }, wecom?: { webhookKey?, token?, aesKey? } }`（密钥项打码展示）。
- CLI：`sjn channel-config feishu set-webhook <url>` / `wecom set-webhook <key>` 等；`show` 脱敏展示。

---

## 6. 文件级改动清单

| 文件 | 动作 |
|---|---|
| `src/core/channel/{types,feishu,wecom,index}.ts` | 新建：渠道客户端（fetch 零依赖） |
| `src/core/workflow/steps/channel.ts` | 新建：`notify.channel` StepKind |
| `src/core/workflow/steps/index.ts` `types.ts` | 改：注册 + StepKind 扩充 |
| `src/core/agent/capabilities/channel.ts` | 新建：`channel_send` 工具 |
| `src/server/routes/hooks.ts` | 改：飞书/企微验签 + challenge 回显 + payload 注入 |
| `src/core/state/` + `cli/commands/` | 改：channels 配置存取 + `channel-config` 命令 |

---

## 7. 安全一致性（合规重点）

- **红线**：仅飞书开放平台 + 企业微信官方 API；**严禁个人微信号自动化**（文档、代码注释、CLI 帮助均写明）。
- 出站 `channel_send`/`notify.channel` needsConfirm；无人值守走白名单授权。
- 入站验签：飞书事件签名 / 企微消息解密必须校验通过才处理，防伪造请求触发工作流。
- 密钥：channels 配置密钥项脱敏展示、不入日志（复用 maskSecret + 审计脱敏）。
- CORS/绑定：hooks 仍经 server 现有校验；生产暴露需配合鉴权（与现有本地服务暴露面一致，属部署约束）。

---

## 8. 验收标准与冒烟点

1. 飞书群机器人 webhook：`channel_send({kind:'feishu',...})` 真实发一条到测试群（需测试 webhook）；
2. 企微群机器人同理；
3. `notify.channel` 步骤在工作流末尾推送执行结果；
4. 入站：模拟飞书 challenge 请求 → hooks 正确回显；带签名事件 → 验签通过后触发 workflow；伪造签名 → 拒绝；
5. `channel-config show` 密钥脱敏；
6. 无凭证时给出清晰配置引导；
7. tsc 0 错误；hooks 既有 W1 功能不回归。

---

## 9. 待用户确认（实施前）

- 先做飞书还是企业微信？（个人微信不做）
- 出站用"群机器人 webhook"（简单，仅推送）还是"应用消息"（需应用凭证，能收发/更全）？
- 提供测试群 webhook / 应用凭证以便冒烟。

---

## 10. 风险与回滚

- 风险：验签实现错误导致伪造触发 → 缓解：严格按官方文档验签，未通过一律拒绝 + 冒烟覆盖伪造用例。
- 风险：webhook 频率限制 → 缓解：出站失败重试有限次 + 记录。
- 回滚：删 channel/ 与 channel.ts 步骤/工具；hooks 去渠道分支；state 的 channels 为增量。
