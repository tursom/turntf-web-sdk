# turntf-web-sdk 开发指南

## 项目概览

`turntf-web-sdk` 是 turntf 分布式通知服务的浏览器端 TypeScript SDK。与 `turntf-js`（Node.js SDK）不同，本 SDK **专为浏览器运行时设计**，不依赖任何 Node.js 内置模块。

### 核心设计决策

- **无 Node.js 依赖**：使用浏览器原生 `fetch` 发起 HTTP 请求，使用原生 `WebSocket` 建立长连接。
- **密码哈希**：依赖 `bcryptjs`（纯 JS 实现，可在浏览器中运行）进行客户端密码哈希。
- **JSON 大数处理**：依赖 `json-bigint` 处理服务端返回的 64 位整数（以十进制字符串形式暴露）。
- **Protobuf 序列化**：使用 `@protobuf-ts/runtime` 进行消息编解码，协议定义在 `proto/client.proto`。
- **ESM 模块**：包格式为 ESM（`"type": "module"`），主入口为 `./dist/index.js`。

### 提供两条能力线

1. **`HTTPClient`**：基于 `fetch` 的 HTTP JSON 客户端，覆盖登录、用户管理、消息管理、附件管理、运维监控等 RESTful API。
2. **`Client`**：基于浏览器原生 `WebSocket` + Protobuf 的长连接客户端，支持自动重连、消息推送、持久化消息自动 ack、会话管理、RPC 请求/响应。

## 构建与测试命令

```bash
npm run gen:proto    # 从 proto/client.proto 生成 TypeScript 代码
npm run typecheck    # tsc --noEmit 类型检查
npm test             # vitest run 运行测试
npm run build        # tsc -p tsconfig.build.json 构建到 dist/
npm run pack:check   # npm pack --dry-run 检查发布内容
npm run prepare      # 构建（npm install 后自动触发）
npm run prepublishOnly # 发布前自动运行：类型检查 + 测试 + 构建
```

## Proto 生成

Protobuf 定义位于 `proto/client.proto`，生成步骤如下：

1. 安装 `protoc` 编译器。
2. 安装 `@protobuf-ts/plugin`（已在 devDependencies 中）。
3. 执行 `npm run gen:proto`，该命令会：
   - 调用 `protoc` 使用 `@protobuf-ts/plugin` 插件生成 TypeScript 代码到 `src/generated/client.ts`。
   - 运行 `scripts/postprocess-generated.mjs` 对生成代码做后处理（添加 `override` 关键字和修复可选链）。
4. 生成的代码通过 `src/index.ts` 的 `export * as proto from "./generated/client"` 对外暴露。

**注意**：生成代码已提交到仓库，修改 proto 后必须重新生成并提交更新后的 `src/generated/client.ts`。

## 模块结构

```
turntf-web-sdk/
  proto/
    client.proto          # Protobuf 协议定义
  scripts/
    postprocess-generated.mjs  # proto 生成代码后处理脚本
  src/
    index.ts              # 入口文件，重导出所有公开 API
    client.ts             # Client 类（WebSocket 长连接客户端）
    http.ts               # HTTPClient 类（HTTP JSON 客户端）
    types.ts              # 公共类型定义（User, Message, Packet 等）
    errors.ts             # 错误类型层次结构
    password.ts           # 密码处理（bcrypt 哈希）
    mapping.ts            # Proto <-> SDK 类型的转换函数
    store.ts              # CursorStore 接口与 MemoryCursorStore 实现
    utils.ts              # 工具函数（JSON 编解码、base64、sleep、AbortSignal 合并等）
    validation.ts         # 输入校验函数
    generated/
      client.ts           # 由 proto 生成的 TypeScript 代码（已提交）
  test/
    client.test.ts        # Client 单元测试
    http.test.ts          # HTTPClient 单元测试
    smoke.test.ts         # 冒烟测试
  dist/                   # 构建产物
  tsconfig.json           # 主 TypeScript 配置
  tsconfig.build.json     # 构建用 TypeScript 配置（继承主配置，设置 noEmit=false）
```

## 关键 API 说明

### `HTTPClient`

构造函数接收 `baseUrl`（如 `/api` 或 `http://localhost:8080`）和可选的 `fetch` 实现（用于注入 mock）。

公开方法分为以下几类：

- **认证**：`login()`、`loginWithPassword()`
- **用户管理**：`createUser()`、`createChannel()`、`getUser()`、`updateUser()`、`deleteUser()`
- **用户元数据**：`getUserMetadata()`、`upsertUserMetadata()`、`deleteUserMetadata()`、`scanUserMetadata()`
- **关系管理**：`createSubscription()`、`subscribeChannel()`、`unsubscribeChannel()`、`listSubscriptions()`
- **黑名单**：`blockUser()`、`unblockUser()`、`listBlockedUsers()`
- **附件管理**：`upsertAttachment()`、`deleteAttachment()`、`listAttachments()`
- **消息**：`listMessages()`、`postMessage()`、`postPacket()`
- **运维**：`listClusterNodes()`、`listNodeLoggedInUsers()`、`listEvents()`、`operationsStatus()`、`metrics()`

所有方法都接受可选的 `RequestOptions`（`{ signal?: AbortSignal; timeoutMs?: number }`）。

### `Client`

构造函数接收 `ClientOptions`，关键字段：

- `baseUrl`：服务端 HTTP 地址，SDK 会自动转换为 `ws[s]` URL。
- `credentials`：登录凭证（`nodeId`、`userId`、`password: PasswordInput`）。
- `cursorStore`：游标存储（默认 `MemoryCursorStore`，浏览器环境可实现 `CursorStore` 接口使用 IndexedDB 持久化）。
- `handler`：事件处理器，需实现 `Handler` 接口（`onLogin`、`onMessage`、`onPacket`、`onError`、`onDisconnect`）。
- `reconnect`：是否启用自动重连（默认 `true`）。
- `ackMessages`：是否自动 ack 持久化消息（默认 `true`）。
- `transientOnly`：是否仅接收瞬态消息（默认 `false`）。
- `realtimeStream`：是否使用实时流端点 `/ws/realtime`（默认 `false`，使用 `/ws/client`）。

客户端同时暴露与 `HTTPClient` 相同签名的方法（如 `createUser()`、`listMessages()`），这些方法通过 WebSocket 连接发起 RPC 请求，适用于已登录的长连接场景。

### `Handler` 接口

```typescript
interface Handler {
  onLogin(info: LoginInfo): void | Promise<void>;      // 登录成功
  onMessage(message: Message): void | Promise<void>;   // 收到持久化消息
  onPacket(packet: Packet): void | Promise<void>;       // 收到瞬态消息
  onError(error: unknown): void | Promise<void>;        // 发生错误
  onDisconnect(error: unknown): void | Promise<void>;   // 连接断开
}
```

`NopHandler` 提供空实现，便于只覆盖需要的回调。

### 共享语义

- 所有 64 位 ID 都以十进制字符串暴露（`nodeId`、`userId`、`seq`、`packetId` 等）。
- 二进制字段统一使用 `Uint8Array`。
- `User.profileJson`、`Attachment.configJson`、`Event.eventJson` 为原始 JSON 字节。
- 消息顺序处理：`saveMessage -> saveCursor -> AckMessage -> handler.onMessage`。
- `AckMessage` 仅影响当前连接的去重；真正的重连恢复依赖 `seenMessages`。

### 错误类型

`TurntfError`（基类）：
- `ClosedError`：客户端已关闭。
- `NotConnectedError`：未连接时尝试发送数据。
- `DisconnectedError`：WebSocket 已断开。
- `ServerError`：服务端返回错误（含 `code`、`serverMessage`、`requestId`，`unauthorized()` 方法检查是否认证错误）。
- `ProtocolError`：协议解析错误。
- `ConnectionError`：连接建立或写入时的底层错误（含 `op` 和 `cause`）。

## 与 turntf-js 的关键差异

| 特性 | turntf-web-sdk | turntf-js |
|------|----------------|------------|
| 运行环境 | 浏览器 | Node.js |
| HTTP 实现 | 原生 `fetch` | `node:http` / `undici` |
| WebSocket 实现 | 原生 `WebSocket` | `ws` 库 |
| 密码哈希 | `bcryptjs`（纯 JS） | `bcrypt`（原生） |
| Base64 | 原生 `btoa`/`atob` | `Buffer` |
| ESM | 原生 ESM | 支持 CJS + ESM |
| DOM 类型 | 依赖 | 不依赖 |
| 模块格式 | 仅 ESM | 双格式 |

由于浏览器环境的限制，本 SDK：
- 不能使用 `Buffer`，所有二进制数据用 `Uint8Array` 表示。
- 不能使用 `ws` 库，依赖 `globalThis.WebSocket`。
- 不能使用 `node:crypto`，依赖 `bcryptjs` 实现密码哈希。
- 不能使用 `fs` / `path` 等文件系统 API。

## 发布指南

本包发布到 npmjs.com 公共注册表（`@tursom/turntf-web-sdk`）。

**发布前检查**：

```bash
npm run typecheck    # 类型检查
npm test             # 运行测试
npm run build        # 构建
npm run pack:check   # 检查发布内容
```

`prepublishOnly` 脚本会自动执行类型检查、测试和构建。

**发布**：

```bash
npm publish
```

发布配置已在 `package.json` 中设置：
- `"publishConfig.registry": "https://registry.npmjs.org/"`
- `"publishConfig.access": "public"`
- `"files"` 包含 `dist/`、`proto/` 和 `README.md`

版本管理遵循语义化版本（SemVer）。

## 代码规范

### TypeScript 配置

- 目标 `ES2022`，模块 `ESNext`，模块解析 `Bundler`。
- 严格模式启用（`strict: true`）。
- 额外严格检查：`noImplicitOverride`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`。

### 风格约定

- 使用 `import type` 导入仅类型引用。
- 公开 API 使用 camelCase。
- 文件内部辅助函数使用常规命名导出或模块级函数。
- 错误优先：输入校验在方法入口进行，失败时立即抛出 `Error`。
- 使用 `async/await` 处理异步操作。
- Promise 链仅在包装遗留回调时使用（如 `new Promise((resolve, reject) => ...)`）。
- 所有 64 位整数以字符串传递，避免 JavaScript `number` 精度丢失。
- 私有方法以下划线前缀（如 `_run()`）—— 当前代码实际未使用此约定，但应保持一致。
- **注意**：当前代码中私有方法没有统一前缀，应遵循类中各方法的命名风格。

### 测试

- 使用 Vitest 测试框架。
- 测试文件位于 `test/` 目录，命名为 `*.test.ts`。
- HTTP 测试通过注入 mock `fetch` 实现。
- WebSocket 测试通过注入模拟的 `WebSocket` 全局变量。

## 提交规范

- 提交信息使用英文。
- 提交信息格式：`type(scope): description`。
  - 类型（type）：`feat`（新功能）、`fix`（修复）、`chore`（杂项）、`docs`（文档）、`refactor`（重构）、`test`（测试）。
  - 范围（scope）：可选的模块标识，如 `client`、`http`、`proto` 等。
  - 描述（description）：小写开头，不加句号。
- 提交作者必须设置为 `tursom <tursom@foxmail.com>`。
- 保持提交粒度适中，每个提交只做一件事。
