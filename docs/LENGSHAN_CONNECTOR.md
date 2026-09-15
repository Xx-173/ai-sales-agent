# Lengshan Connector 对接规范

AI Sales Agent 不保存企微凭据，也不直接调用企微。Lengshan 是唯一的企微收发层：它验证企微事件、保存原始消息/图片地址、执行已审核模板，并将脱敏事件交给本服务决策。

```text
企微 → Lengshan → AI Sales Agent → 持久化 SOP / Outbox / 人工接管
             ↑             ↓
             └── 领取模板动作、发送、回传结果 ──┘
```

## 启用 Connector

在 AI Sales Agent 的服务器上设置强随机密钥；不要提交、截图或发送该值：

```powershell
$env:LENGSHAN_SALES_WEBHOOK_SECRET = "<server-side-secret>"
```

Lengshan 对每个请求发送两个 Header：

```text
X-Lengshan-Timestamp: 2026-09-15T08:00:00.000Z
X-Lengshan-Signature: sha256=<hex>
```

签名计算为 `HMAC_SHA256("${timestamp}.${rawBody}", sharedSecret)`。服务只接受 5 分钟内的时间戳，并用常量时间比较签名。没有配置密钥时，所有 Lengshan 路由返回 `503`，不会退化为未鉴权访问。

## 入站事件

`POST /api/sales/lengshan/events`

Lengshan 应在完成企微验签后调用此接口。只传业务判断所需的脱敏信息；原始企微消息、企微凭据、真实姓名和手机号不应进入 AI Sales Agent。

```json
{
  "eventId": "lengshan-message-000001",
  "customer": {
    "customerId": "opaque-contact-001",
    "sopDay": 1,
    "messageConsent": true,
    "tags": ["new_friend"],
    "isNewFriend": true
  },
  "message": {
    "text": "想了解体验课和排盘",
    "mediaTypes": ["image"]
  },
  "receivedAt": "2026-09-15T08:00:00.000Z"
}
```

返回的 `action` 仅代表销售决策。`send_template` 仍须由 Lengshan 从 Outbox 领取后执行；`handoff` 和 `blocked` 不得自动外发。

```json
{
  "duplicate": false,
  "action": {
    "actionId": "action-lengshan-message-000001",
    "kind": "send_template",
    "status": "queued",
    "templateKey": "welcome_course",
    "templateVariables": { "sopDay": "1", "sopStage": "trial_welcome" },
    "reason": "approved_sop_template"
  }
}
```

`eventId` 是幂等键。重复事件不会产生第二次待发送动作。

## Outbox 闭环

1. Lengshan 调用 `POST /api/sales/lengshan/outbox/claim`，Body 为 `{ "limit": 20 }`。
2. 服务以 5 分钟租约将待发送动作标为 `dispatching` 并返回。Lengshan 只能执行 `kind: "send_template"` 的动作。
3. Lengshan 使用自己维护的、已审核的 `templateKey → 文案/课程链接/企微发送参数` 映射发送消息。
4. Lengshan 调用 `POST /api/sales/lengshan/actions/result` 回传结果：

```json
{
  "actionId": "action-lengshan-message-000001",
  "status": "sent",
  "deliveredAt": "2026-09-15T08:01:00.000Z",
  "providerMessageId": "lengshan-provider-message-001"
}
```

只有收到 `sent` 回执，客户才会推进到下一 SOP 天数并在 24 小时后生成下一次待处理节点。`failed` 不会推进；管理员可通过浏览器认证接口 `POST /api/sales/actions/:actionId/retry` 显式重试。

## 定时 SOP

Lengshan 的定时任务可定期调用 `POST /api/sales/lengshan/ticks/due`：

```json
{ "limit": 50, "at": "2026-09-16T08:00:00.000Z" }
```

它会为到期且已同意触达的客户创建下一条 SOP 动作。若条件标签不满足，动作会被阻断而不会发送。

## D1–D20 与模板

[`config/sales-sop-plan.json`](../config/sales-sop-plan.json) 是版本化 SOP 决策表，定义每天对应的阶段、审核模板 Key、前置标签和是否必须转人工。它不保存真实话术、课程链接或价格。

Lengshan 必须维护同名的已审核模板映射。例如 `welcome_course`、`trial_course_guidance`、`course_link`、`reactivation`。修改计划或模板前应经过运营审核；不要让模型自行生成外发价格、优惠、承诺或链接。

## 人工接管与运营

- 价格/付款、负面情绪、退订、疑似绕过风险，以及 D10/D20 转化节点都会创建 `handoff`。
- 登录后的管理员可以使用 `/api/sales/handoffs` 查看队列，并通过 `/api/sales/handoffs/:actionId/resolve` 关闭处理项。
- `/api/sales/metrics` 提供客户数、Outbox 状态计数、发送失败数和待人工数；`/api/sales/traces` 只返回脱敏 Trace。

## 仍需由 Lengshan 或模型层提供的能力

- 企微官方收发、企微回调验签、账号/会话映射和真实模板发送。
- 图片 URL 的下载、OCR/视觉模型调用，以及将安全的识别标签写入 `customer.tags`。
- Dify 或 SalesClaw 模型的语义分类、话术草稿生成和人工审核工作台。

这些能力不应绕过 Outbox、频控、同意校验和人工接管规则。
