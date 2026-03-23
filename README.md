# Web Agent Console

Web Agent Console 是一个本地优先的浏览器控制台，用来查看和操作命令行 Agent 会话。它把项目列表、会话历史、流式输出、审批、用户提问和附件交互集中到一个 Web 界面里，方便你在浏览器里观察和继续本地 Agent 工作流。

当前项目支持两条主要后端路径：

- `codex`：通过受控的 `codex app-server` 驱动会话
- `claude-sdk`：通过 `@anthropic-ai/claude-agent-sdk` 复用本地 Claude 会话与认证

这仍然是一个本地优先的 PoC，更适合个人使用、原型验证和内部工具场景，而不是直接作为生产部署方案。

## 主要能力

- 按工作目录聚合项目和会话
- 在浏览器中查看流式输出、任务进度和运行状态
- 在 UI 中处理工具审批和用户问题
- 为单个会话切换模型和推理强度
- 上传附件并按后端能力做校验
- 页面刷新或服务重启后恢复部分会话状态
- 可选共享密码认证
- 可接收独立 Claude 进程回传的 hook 事件

## 适合谁

- 想用浏览器而不是纯终端来观察 Agent 执行过程的人
- 需要在图形界面里完成审批、回答问题、继续对话的人
- 同时维护多个工作目录，希望统一查看会话的人

## 快速开始

### 环境要求

- Node.js 22+
- 如果使用 `codex` provider，需要本地 `codex` 可执行文件和可用的登录态
- 如果使用 `claude-sdk` provider，需要本地 Claude Code / Agent SDK 登录态

### 安装依赖

```bash
npm install
```

### 默认启动

```bash
npm start
```

默认会启动 `codex` provider，并在 `http://127.0.0.1:4318` 提供 Web 界面。

### 选择后端 provider

使用 `codex`：

```bash
WEB_AGENT_PROVIDER=codex npm start
```

使用 `claude-sdk`：

```bash
WEB_AGENT_PROVIDER=claude-sdk npm start
```

### 固定端口启动

如果你想用固定端口调试或在局域网内访问，可以使用：

```bash
./scripts/start-local-4533.sh --help
```

示例：

```bash
WEB_AGENT_AUTH_PASSWORD=demo-password \
./scripts/start-local-4533.sh --sandbox danger-full-access --approval on-request
```

这个脚本默认会把 Web 界面暴露在 `http://0.0.0.0:4533`。

## Provider 支持情况

| Provider | 状态 | 说明 | 附件支持 |
| --- | --- | --- | --- |
| `codex` | 可用 | 当前默认路径，支持会话管理、审批、流式更新和会话设置 | 仅图片 |
| `claude-sdk` | 可用 | 支持 Claude 会话、审批、提问、会话设置和外部 hook 桥接 | 图片、文本、PDF |
| `agentapi` | 未完成 | 当前仅为占位实现，不建议在实际使用中启用 | 不支持 |

## 常见用法

### 启用共享密码认证

```bash
WEB_AGENT_AUTH_PASSWORD=demo-password npm start
```

### 运行 smoke 检查

```bash
npm run smoke
```

如果你想验证 `claude-sdk` 路径：

```bash
WEB_AGENT_PROVIDER=claude-sdk npm run smoke
```

### 接收 Claude hook 事件

如果你希望把独立运行的 Claude Code 进程中的审批、提问和状态同步到这个控制台，可以使用：

```bash
export CLAUDE_HOOK_SECRET=change-me
export WEB_AGENT_HOOK_SECRET="$CLAUDE_HOOK_SECRET"
export WEB_AGENT_RELAY_URL="http://127.0.0.1:4318"
node ./scripts/claude-hook-relay.mjs
```

## 注意事项

- 这是本地优先的 PoC，不是生产级多用户平台。
- `codex` 路径默认使用 `danger-full-access` sandbox 和 `on-request` approval policy，如需更严格限制请显式覆盖。
- 如果你通过 `start-local-4533.sh` 对外监听 `0.0.0.0`，建议至少启用 `WEB_AGENT_AUTH_PASSWORD`，并配合主机防火墙使用。
- `agentapi` 目前不是完整实现。
- 不同 provider 的附件能力不同，`codex` 只支持图片，`claude-sdk` 支持图片、文本和 PDF。

## 已知限制

- 还没有完善的多用户、权限、审计和生产级安全模型
- 状态主要保存在本地 JSON 文件中，而不是数据库
- Claude 外部进程与 Web 控制台之间的待处理动作一致性依赖 hook relay 配置是否正确

## 开发者文档

如果你要了解项目结构、架构设计、环境变量、状态文件、接口和测试方式，请查看 [DESIGN.md](DESIGN.md)。
