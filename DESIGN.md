# DESIGN

本文档面向维护者和开发者，解释 Web Agent Console 的设计目标、分层结构、后端多 provider 方案、前后端接口方案，以及为了补足底层能力差异而在应用层额外实现的补偿机制。

## 1. 设计目标

Web Agent Console 是一个本地优先的浏览器控制台，用来承接本地 Agent 会话。它不是一个“新的 Agent 后端”，而是一个位于浏览器和本地 Agent 运行时之间的统一应用层。

项目的核心目标有四个：

1. 用统一的项目/会话模型承接不同后端。
2. 用统一的 UI 处理流式输出、审批、提问、附件和会话设置。
3. 在底层能力不一致时，由应用层补足缺口，而不是把差异直接暴露给前端。
4. 在本地重启、刷新或外部进程参与时，尽量恢复和延续运行状态。

因此，这个项目的真正设计重点不是页面渲染，而是“多种本地 Agent 能力如何被统一映射成一个稳定的前后端契约”。

## 2. 系统总览

运行时由四层组成：

1. 浏览器前端
   位于 `public/`，负责项目树、会话详情、审批、提问、附件和设置交互。
2. HTTP / SSE 外壳
   位于 `src/lib/http-server.js`，负责认证、REST 接口、SSE 实时事件、静态资源，以及 provider 自声明 ingress 路由。
3. 应用层统一模型
   由 `ProviderAdapter`、`SessionService`、`ActivityStore`、`RuntimeStore` 等组成，负责把不同 provider 的能力折叠成统一会话模型。
4. 具体 provider 实现
   当前包括 `codex`、`claude-sdk` 和占位态的 `agentapi`。

入口在 [src/server.js](src/server.js)：

- 读取配置
- 创建 `ActivityStore`
- 创建 `RuntimeStore`
- 根据配置选择 provider
- 创建 HTTP server
- 启动 provider
- 监听信号并优雅关闭

这意味着项目的主拓扑是：

`Browser -> HTTP/SSE -> ProviderAdapter contract -> concrete provider -> local backend/runtime`

## 3. 分层架构

### 3.1 展示层：浏览器前端

主要文件：

- [public/index.html](public/index.html)
- [public/app.js](public/app.js)
- [public/app.css](public/app.css)
- [public/composer-attachments.js](public/composer-attachments.js)

前端不直接理解底层 provider 的内部结构，只消费应用层提供的统一对象：

- `project`
- `thread`
- `turn`
- `item`
- `runtime`
- `pending approval`
- `pending question`
- `session options`

前端与后端的交互策略是：

- 用 HTTP 拉取当前快照
- 用 HTTP 提交变更命令
- 用 SSE 订阅增量事件

这使得前端无需知道底层是 Codex JSON-RPC、Claude SDK 调用还是外部 hook 事件。

### 3.2 传输层：HTTP + SSE 外壳

核心文件：

- [src/lib/http-server.js](src/lib/http-server.js)
- [src/lib/auth.js](src/lib/auth.js)
- [src/lib/turn-request.js](src/lib/turn-request.js)

HTTP server 的职责不是“包含业务逻辑”，而是：

- 认证和路由分发
- 请求体解析与参数归一化
- 调用 provider 统一接口
- 将 provider 发布的事件广播为 SSE
- 接收 provider 声明的自定义 ingress 路由

这个设计避免了在传输层写 provider 分支逻辑。除了少量通用 REST 路由外，provider 特有入口通过 `provider.getIngressRoutes()` 注入。

### 3.3 应用层：统一会话契约

核心文件：

- [src/lib/provider-adapter.js](src/lib/provider-adapter.js)
- [src/lib/session-service.js](src/lib/session-service.js)
- [src/lib/activity-store.js](src/lib/activity-store.js)
- [src/lib/runtime-store.js](src/lib/runtime-store.js)

这一层是本项目最重要的设计资产。它定义了 provider 需要实现的统一应用能力，包括：

- 列项目与会话
- 读取会话详情
- 发起 turn / 中断 turn
- 项目操作
- 会话重命名
- 审批模式读取和切换
- 会话设置读取和写入
- 审批和问题的处理
- 自定义 ingress 路由
- 状态订阅

`SessionService` 进一步提供共享能力：

- pending action 模型
- 审批模式
- 线程运行时快照
- 线程设置
- 待审批和待提问的发布/恢复
- 项目树聚合

### 3.4 集成层：具体 provider

这一层负责把底层能力接进统一应用层契约。不同 provider 可以拥有不同的传输方式、恢复策略和补偿机制，但前端看到的契约保持尽量一致。

## 4. 后端多 Provider 方案

### 4.1 设计原则

多 provider 不是简单的“if/else 切换后端”，而是以下几件事的组合：

- 各 provider 对外暴露同一组应用层方法
- 各 provider 暴露自己的能力差异给 `/api/session-options`
- 对无法直接对齐的能力，由应用层做额外补偿
- provider 特有入口通过 ingress route 自声明，而不是硬编码到 HTTP server

provider 选择逻辑位于 [src/lib/provider-factory.js](src/lib/provider-factory.js)。

### 4.2 `codex` provider

关键文件：

- [src/lib/codex-provider.js](src/lib/codex-provider.js)
- [src/lib/codex-session-service.js](src/lib/codex-session-service.js)
- [src/lib/codex-app-server.js](src/lib/codex-app-server.js)
- [src/lib/json-rpc-client.js](src/lib/json-rpc-client.js)
- [src/lib/codex-event-mapper.js](src/lib/codex-event-mapper.js)

`codex` 路径的特点：

- Node 进程会托管一个本地 `codex app-server`
- 通过 WebSocket JSON-RPC 与它通信
- 支持线程列表、线程详情、turn 启动、中断、审批等主路径能力
- 后端重连失败时会尝试重启托管 app-server
- 即使 app-server 断开，也会主动从外部 rollout 文件补全运行状态

`CodexProvider` 本身还承担了连接恢复职责：

- 正常请求前先确保底层连接可用
- 遇到可恢复错误时，优先尝试重连
- 重连失败再重启托管 app-server
- 若发生重启，主动把活跃会话标记为 interrupted

也就是说，`codex` provider 不是“薄代理”，而是自带运行时托管与恢复逻辑的适配器。

### 4.3 `claude-sdk` provider

关键文件：

- [src/lib/claude-sdk-provider.js](src/lib/claude-sdk-provider.js)
- [src/lib/claude-sdk-session-service.js](src/lib/claude-sdk-session-service.js)
- [src/lib/claude-sdk-event-mapper.js](src/lib/claude-sdk-event-mapper.js)
- [src/lib/claude-transcript-adapter.js](src/lib/claude-transcript-adapter.js)
- [src/lib/claude-sdk-session-index.js](src/lib/claude-sdk-session-index.js)

`claude-sdk` 路径的特点：

- 直接调用 `@anthropic-ai/claude-agent-sdk`
- 不托管独立后端进程
- 线程在应用层拥有自己的 `threadId`
- 底层 Claude session id 通过 `ClaudeSdkSessionIndex` 建立映射
- 会从 SDK 发现已有 Claude sessions，并把它们补到项目树里
- 可以通过 hook ingress 把“外部独立 Claude 进程”的状态接入当前控制台

这里的设计重点不只是“调用 SDK”，而是把三类会话统一起来：

- 本应用创建并驱动的 Claude 会话
- 通过 SDK 发现到的已有 Claude 会话
- 通过 hook ingress / transcript watcher 跟踪的外部 Claude 会话

### 4.4 `agentapi` provider

关键文件：

- [src/lib/agent-api-provider.js](src/lib/agent-api-provider.js)

`agentapi` 当前是占位实现，它的存在意义主要有两个：

- 让 provider 契约从一开始就按“多后端”设计，而不是死绑 `codex`
- 为未来接入新的远程 Agent API 保留稳定的应用层接口

当前它只提供最基本的项目与占位线程能力，不支持真实 turn、审批和运行恢复。

### 4.5 Provider 能力对比

| 维度 | `codex` | `claude-sdk` | `agentapi` |
| --- | --- | --- | --- |
| 底层接入方式 | 托管 `codex app-server` + JSON-RPC | 本地 SDK 调用 | 占位 |
| 线程标识 | 底层 thread id 直接作为应用 thread id | 应用 thread id 映射到底层 Claude session id | 占位 id |
| 实时事件来源 | app-server 通知 + rollout 文件补偿 | SDK 流事件 + 外部 hook / transcript watcher | 无 |
| 审批/提问 | 底层审批请求映射为 pending action | SDK 工具审批 + hook 事件映射为 pending action | 无 |
| 附件支持 | 图片 | 图片 / 文本 / PDF | 无 |
| 会话发现 | 来自底层线程列表 | 来自 SDK `listSessions` + 索引 | 无 |
| 恢复机制 | 重连/重启 app-server + rollout 补偿 | 启动时中断活跃会话 + transcript/hook 补偿 | 无 |

## 5. 前后端接口方案

整个接口层分为三类：

1. 快照型 REST 接口
2. 命令型 REST 接口
3. SSE 事件流

### 5.1 快照型接口

用于给前端加载当前状态。

主要包括：

- `GET /api/sessions`
  返回项目树，包含 `focusedSessions` 和 `historySessions`
- `GET /api/sessions/:id`
  返回单个线程详情
- `GET /api/status`
  返回 relay/backend/request 的状态
- `GET /api/approval-mode`
  返回当前审批模式
- `GET /api/session-options`
  返回当前 provider 的能力声明
- `GET /api/sessions/:id/settings`
  返回线程级设置
- `GET /api/auth/session`
  返回当前认证状态

### 5.2 命令型接口

用于改变后端状态。

主要包括：

- `POST /api/sessions/:id/turns`
- `POST /api/sessions/:id/interrupt`
- `POST /api/sessions/:id/name`
- `POST /api/sessions/:id/settings`
- `POST /api/approval-mode`
- `POST /api/approvals/:id/approve`
- `POST /api/approvals/:id/deny`
- `POST /api/pending-actions/:id/respond`
- `POST /api/projects`
- `POST /api/projects/:id/sessions`
- `POST /api/projects/:id/focused-sessions`
- `DELETE /api/projects/:id/focused-sessions/:threadId`
- `POST /api/projects/:id/collapse`
- `DELETE /api/projects/:id`
- `POST /api/auth/login`
- `POST /api/auth/logout`

这些接口都不直接暴露底层 provider 细节，而是统一调用 `provider` 抽象方法。

### 5.3 Provider ingress 接口

这类接口不是 HTTP server 预定义的，而是 provider 通过 `getIngressRoutes()` 动态声明。

当前最重要的例子是 `claude-sdk`：

- `POST /api/providers/claude/hooks`

这样做的好处是：

- 避免在 HTTP server 写死 provider 特有逻辑
- 让新增 provider 时，只需实现自己的 ingress 和处理逻辑
- 保持传输层通用、provider 特性可插拔

### 5.4 SSE 事件流

事件流位于：

- `GET /api/events`

它承载的是“增量变化”，而不是完整快照。前端通过初始快照 + 增量事件来构建当前 UI 状态。

事件大致分为五类：

1. 线程和 turn 生命周期
   - `thread_status_changed`
   - `turn_started`
   - `turn_completed`
   - `thread_name_updated`
2. 线程 item 流
   - `thread_item_started`
   - `thread_item_completed`
   - `thread_item_delta`
3. 计划和运行时
   - `turn_plan_updated`
   - `session_runtime_reconciled`
4. 审批与提问
   - `approval_requested`
   - `approval_resolved`
   - `pending_question_requested`
   - `pending_question_resolved`
5. 全局设置
   - `approval_mode_changed`

`codex` 与 `claude-sdk` 各自产生原生事件，但都会先经过 mapper 归一化：

- [src/lib/codex-event-mapper.js](src/lib/codex-event-mapper.js)
- [src/lib/claude-sdk-event-mapper.js](src/lib/claude-sdk-event-mapper.js)

### 5.5 能力协商接口

前端并不硬编码 provider 能力，而是通过 `/api/session-options` 获取：

- `providerId`
- `attachmentCapabilities`
- `modelOptions`
- `reasoningEffortOptions`
- `defaults`

这使得前端可以根据 provider 自动调整：

- 是否允许附件
- 允许哪些附件类型
- 展示哪些模型
- 展示哪些推理强度选项

## 6. 超越底层能力时的补充方案

这一节是整个系统最重要的“设计补偿层”。因为 Codex 和 Claude SDK 在能力、事件、状态恢复和外部进程协同时并不一致，应用层必须主动补足差异。

### 6.1 统一 `PendingAction` 模型

底层并没有统一的“待处理动作”概念，但前端需要统一显示：

- 工具审批
- 用户提问

因此应用层将两者都收敛为 `pendingAction`，并在运行时进一步映射成：

- `approval`
- `pendingQuestion`

对应实现主要在：

- [src/lib/session-service.js](src/lib/session-service.js)
- [src/lib/runtime-store.js](src/lib/runtime-store.js)

这带来的好处是：

- 前端只需要处理一种待处理动作框架
- provider 只需要把底层事件映射为统一动作
- 待处理动作可以被持久化、恢复和重放

### 6.2 审批模式是应用层能力，不是底层直出能力

应用层维护 `approvalMode`：

- `auto-approve`
- `manual`

它被持久化在 `RuntimeStore` 中，并用于控制新的 pending approval 如何处理。

这意味着：

- 即便底层 provider 表达审批的方式不同，前端仍然只看到统一的审批模式
- 应用层可以在收到新的审批请求时直接自动批准，而不是把逻辑散落在前端

### 6.3 线程设置抽象：统一模型与推理强度

不同 provider 支持的模型和 reasoning effort 不同，但前端需要统一交互面板。

应用层通过：

- `getSessionOptions()`
- `getSessionSettings()`
- `setSessionSettings()`

把它们统一成线程级设置模型，并持久化到 `RuntimeStore.threadSettings`。

这是一层典型的“能力协商 + 应用层持久化”的抽象，而不是把底层 SDK/CLI 的原始配置直接透给前端。

### 6.4 Turn 请求兼容层

`turn/start` 目前支持两种输入形式：

- 旧形式：`text + settings`
- 新形式：对象化 `turnRequest`

归一化逻辑在 [src/lib/turn-request.js](src/lib/turn-request.js)。

这层兼容使得：

- 旧调用方不需要马上升级
- 新调用方可以传更完整的对象结构
- HTTP 层与 provider 层都只消费归一化后的同一种对象

### 6.5 Codex 的外部 rollout 补偿

Codex 主路径依赖托管的 `app-server`，但会有一种情况：

- app-server 已经断开
- 或当前线程不是由当前 app-server 持续驱动
- 但底层 rollout 文件中仍然有运行痕迹

为了解决这个问题，`CodexSessionService` 会通过 [src/lib/rollout-thread-reader.js](src/lib/rollout-thread-reader.js) 读取 rollout 文件，构造：

- 补充的线程内容
- `externalRollout` 运行时快照

这使前端即使在 app-server 重启、断开或不再掌握运行中的线程时，也能看到更完整的状态，而不是直接丢失上下文。

### 6.6 Claude 的外部 hook 桥接

Claude SDK 主路径只能覆盖“本应用直接发起的 SDK 查询”，但现实里还存在另一类会话：

- 独立运行的 Claude Code 进程
- 它们不经过当前应用创建，却希望把审批、提问和运行状态同步到当前控制台

为此，项目实现了外部桥接层：

- [src/lib/claude-external-session-bridge.js](src/lib/claude-external-session-bridge.js)
- [scripts/claude-hook-relay.mjs](scripts/claude-hook-relay.mjs)

处理流程是：

1. 外部进程产生命令/审批/提问/停止等 hook 事件
2. relay 脚本将 stdin JSON 转发到 `POST /api/providers/claude/hooks`
3. `ClaudeSdkProvider` 通过 ingress route 接收
4. `ClaudeSdkSessionService` 将这些事件映射成统一 pending action、runtime 和 thread 状态

这套机制本质上是把“当前应用之外的 Claude 运行时”投影到应用模型中。

### 6.7 Claude transcript watcher 与 transcript adapter

仅靠 hook 事件还不够，因为 hook 事件只覆盖部分状态，不提供完整会话历史。因此项目还实现了 transcript 补偿层：

- [src/lib/claude-external-transcript-watcher.js](src/lib/claude-external-transcript-watcher.js)
- [src/lib/claude-transcript-adapter.js](src/lib/claude-transcript-adapter.js)

它们的作用是：

- 监听外部 Claude transcript 变化
- 从 transcript 中恢复 turns 和 items
- 将 Claude 的消息块映射成统一的 UI item 结构
- 补充 task/todo、工具调用、附件摘要等信息

也就是说，hook ingress 负责“事件接入”，transcript adapter 负责“历史重建”，两者结合后外部 Claude 会话才能在控制台里接近一等公民。

### 6.8 Claude 的应用线程 ID 与底层 session ID 分离

Claude provider 没有直接沿用底层 session id 作为 UI thread id，而是通过 [src/lib/claude-sdk-session-index.js](src/lib/claude-sdk-session-index.js) 维护映射：

- `threadId`：应用层主键
- `claudeSessionId`：底层 SDK session id

这样做的原因是：

- 可以先创建应用线程占位，再在第一次发送后 materialize 底层 session id
- 可以吸收“发现到的已存在 Claude session”
- 可以记录 `discovered`、`hooked`、`hooked+tail` 等桥接模式
- 可以在 dedupe 和迁移时保持应用层主键稳定

### 6.9 附件的能力补偿与摘要补偿

底层 provider 的附件能力差异很大：

- Codex 只接受图片
- Claude 接受图片、文本、PDF

项目在两层做了补偿：

1. 提交前校验
   前端和后端都会根据 provider 能力限制附件
2. 读取时摘要
   Claude transcript 中的附件会被转成 `attachmentSummary`，避免前端必须理解底层 block 格式

对应实现：

- [src/lib/codex-attachments.js](src/lib/codex-attachments.js)
- [src/lib/claude-attachments.js](src/lib/claude-attachments.js)
- [public/composer-attachments.js](public/composer-attachments.js)

### 6.10 RuntimeStore 的 legacy 迁移

`RuntimeStore` 不只是一个 JSON 持久化容器，它还承担了历史快照迁移职责：

- 老版本 `approvalMode` 会迁移到新的语义
- 老版本 `approvals` 结构会迁移到统一 `pendingActions`

这意味着应用层可以逐步演进待处理动作模型，而不必因为本地历史文件而完全放弃旧格式兼容。

## 7. 关键数据模型

### 7.1 Project

项目树不是直接来自 provider 原始数据，而是“底层线程 + ActivityStore 覆盖层”的聚合结果。

一个 project 主要包含：

- `cwd`
- `displayName`
- `collapsed`
- `focusedSessions`
- `historySessions.active`
- `historySessions.archived`

这里 `focusedSessions` 是应用自定义概念，不是底层线程系统的原生概念。

### 7.2 Thread

线程对象承载给前端的完整视图，通常是以下信息的叠加：

- 底层 provider 返回的线程元信息
- turns / items
- runtime snapshot
- pending approvals / questions
- thread settings

因此 thread 是“应用拼装后的视图对象”，而不是底层 provider 对象的直接透传。

### 7.3 Turn 和 Item

统一 turn/item 模型使不同 provider 可以共享同一 UI 渲染逻辑。

常见 item 类型包括：

- `userMessage`
- `agentMessage`
- `commandExecution`
- `mcpToolCall`
- `attachmentSummary`

事件流里还会用增量事件持续更新 item。

### 7.4 Runtime Snapshot

运行时快照描述当前线程是否正在运行以及实时状态，核心字段包括：

- `turnStatus`
- `activeTurnId`
- `diff`
- `realtime`
- `source`

`source` 目前区分：

- `appServer`
- `externalRollout`
- `claude-hook`

这使前端能够知道当前状态来自哪里，也让恢复逻辑可以按来源区别处理。

### 7.5 Pending Action

统一待处理动作结构至少包含：

- `id`
- `threadId`
- `originThreadId`
- `turnId`
- `itemId`
- `kind`
- `summary`
- `payload`
- `status`
- `createdAt`
- `resolvedAt`
- `resolutionSource`

`kind` 当前主要有：

- `tool_approval`
- `ask_user_question`

## 8. 状态与持久化分层

### 8.1 `ActivityStore`

负责保存 UI 级项目状态：

- 项目是否隐藏
- 项目是否折叠
- 哪些线程被置于 focused 区

这是“项目树组织方式”的持久层，而不是运行时状态层。

### 8.2 `RuntimeStore`

负责保存运行时状态：

- 审批模式
- pending actions
- thread runtime
- thread settings

这让页面刷新、服务重启和待处理动作恢复成为可能。

### 8.3 `ClaudeSdkSessionIndex`

负责 Claude 特有的线程索引与映射：

- `threadId <-> claudeSessionId`
- `projectId`
- `summary`
- `bridgeMode`
- `transcriptPath`
- `lastSeenAt`

它既是查询索引，也是 dedupe / merge 的基础。

### 8.4 视图对象的组装来源

最终前端看到的一个线程，往往是以下几层数据拼出来的：

1. provider 原始线程
2. 运行时快照覆盖层
3. 待处理动作覆盖层
4. 线程设置覆盖层
5. ActivityStore 里的项目树组织信息

这种多层叠加是本项目的一条重要设计主线。

## 9. 认证与安全边界

### 9.1 共享密码认证

共享密码认证是一个本地友好的轻量保护机制：

- 开启条件：设置 `WEB_AGENT_AUTH_PASSWORD`
- 介质：`HttpOnly` Cookie
- 保护范围：大部分 `/api/*` 路由

它适用于本地或可信网络中的轻量保护，不适合作为正式多用户权限系统。

### 9.2 Hook ingress 的额外保护

Claude hook ingress 额外使用两层约束：

1. 只接受 loopback 地址
2. 可选 `x-web-agent-hook-secret`

这是因为它本质上是“本机进程对本机控制台的回传通道”，不应该被当作公网 API。

### 9.3 Codex sandbox / approval policy 透传

对于 `codex` provider，应用并不自己实现底层沙箱，而是把：

- `CODEX_SANDBOX_MODE`
- `CODEX_APPROVAL_POLICY`

透传给托管的 `codex app-server`。

应用层只负责：

- 展示当前审批模式
- 维护自己的 pending action 流程
- 在需要时对线程运行状态做恢复或中断标记

## 10. 脚本与运行模式

### 10.1 `npm start`

最标准的入口，执行：

```bash
node ./src/server.js
```

### 10.2 `scripts/start-local-4533.sh`

这是一个面向本地固定端口调试的便捷脚本，主要价值是：

- 固定 relay 端口和 Codex app-server 端口
- 显式暴露 sandbox / approval CLI 选项
- 可快速启用共享密码认证

### 10.3 `scripts/smoke-local.sh`

这是本地 smoke 检查脚本，用于：

- 安装依赖
- 启动服务
- 等待 `/api/sessions` 就绪
- 输出一组人工验证提示

它同时覆盖：

- `codex` 路径
- `claude-sdk` 路径

### 10.4 `scripts/claude-hook-relay.mjs`

这个脚本是外部 Claude 进程和当前控制台之间的适配桥：

- 从 stdin 读取 JSON
- 转发到本地 hook ingress
- 可等待 resolution 并将结果写回 stdout

## 11. 测试策略

测试使用 Node 内置测试框架，覆盖范围较广，主要包括：

- provider factory 与 provider 行为
- HTTP server 路由与认证
- Codex app-server / JSON-RPC 交互
- Claude SDK session service
- runtime/activity 存储
- 前端状态与渲染助手
- 脚本行为

测试目录主要在：

- `tests/http-server.test.js`
- `tests/provider-factory.test.js`
- `tests/codex-session-service.test.js`
- `tests/claude-sdk-session-service.test.js`
- `tests/ui-state.test.js`

这个测试布局反映了项目的实际重心：

- 应用层契约
- provider 适配
- 状态恢复
- 前端状态机

## 12. 主要扩展点

如果未来继续扩展，这些位置是最自然的入口：

### 12.1 新 provider

实现一个新的 `ProviderAdapter` 子类，并按需要提供：

- 基础 CRUD / turn 操作
- 状态订阅
- session options
- ingress routes

### 12.2 更强的持久化

可以把 `ActivityStore`、`RuntimeStore`、`ClaudeSdkSessionIndex` 从 JSON 文件迁移到数据库，但前提是保留当前应用层对象模型。

### 12.3 更强的认证与多用户

当前共享密码认证可以升级为：

- 用户体系
- 权限控制
- 审计日志
- 多租户隔离

### 12.4 更丰富的前端协议

如果未来需要 WebSocket、双向流或更细粒度订阅，可以在保持当前应用层事件语义的前提下替换传输层，而不必重写 provider 适配逻辑。

## 13. 当前限制

- 当前仍是本地优先 PoC，不是生产级部署方案
- `agentapi` 未完成
- 多用户、权限和审计尚未建立
- 共享密码认证只是轻量保护
- Claude 外部会话集成依赖 hook 与 transcript 侧的正确配置
