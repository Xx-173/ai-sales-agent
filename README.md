# AI Sales Agent

> 基于 [SalesClaw](https://github.com/Xx-173/salesclaw) / Pi Agent Runtime 的销售 SOP 服务：由 Lengshan 负责企微消息收发，本服务负责状态、决策、Outbox 与人工接管。
>
> 本仓库不保存企微凭据或直接操作企微账号。真实消息由 Lengshan 中转；本服务只接收经验证的脱敏事件并产生受控动作。

## 项目关系

[SalesClaw](https://github.com/Xx-173/salesclaw) 是本项目的自托管 Agent 工作台基座：提供 Agent、工作区、会话、工具、渠道与任务的可治理运行环境。本仓库在这一产品架构上实现面向销售场景的 SOP 编排与安全控制。

为保证演示可独立运行，本仓库保留了所需运行时代码；它不是对 `salesclaw` 仓库的实时拉取，也不代表 SalesClaw 已原生接入真实企业微信或全自动外发。

```text
Lengshan（企微验签、消息收发、模板映射）
        ↓
脱敏 Sales SOP 服务层
        ↓
SalesClaw Turn / Agent 上下文
        ↓
持久化动作：Outbox 待发送 / 人工接管 / 阻断
        ↓
脱敏 Trace 与审计记录
```

## 本仓库的销售 SOP 模块

- `src/sales-sop.ts`：D1–D20 SOP 决策、意图/标签、同意校验、频控和人工接管。
- `src/sales-store.ts`：SQLite 客户状态、脱敏 Trace、Outbox、发送回执、重试和人工队列。
- `src/routes/sales-sop.ts`：Lengshan HMAC 接口、管理员运营接口和本地演示接口。
- `config/sales-sop-plan.json`：可审核、可版本化的 D1–D20 模板 Key 与标签条件。
- `docs/LENGSHAN_CONNECTOR.md`：Lengshan 接入、签名、Outbox 和回执契约。

## 安全边界

- Lengshan 是唯一的企微收发层；AI Sales Agent 只返回模板 Key，不能自行外发。
- 客户以不透明 `customerId` 表示；Trace 只记录输入指纹、标签、意图与动作，不保存消息原文。
- 价格、付款、投诉、退订、负面情绪及低置信度场景必须人工接管。
- Lengshan 请求必须使用 HMAC 签名；Outbox 领取、发送回执、幂等、频控、授权模板和人工接管均被持久化记录。

## 本地验证

要求 Node.js 20+：

```bash
npm install
npm run typecheck
npm test -- --run tests/sales-sop.test.ts tests/sales-store.test.ts tests/lengshan-sales-auth.test.ts
```

对接方式请参阅 [docs/LENGSHAN_CONNECTOR.md](docs/LENGSHAN_CONNECTOR.md)。

## 许可

本仓库遵循 MIT License。`LICENSE` 保留了随源代码附带的版权与许可声明；本仓库新增的脱敏销售 SOP 模块也按同一许可发布。
