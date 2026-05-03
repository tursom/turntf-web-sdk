# turntf-web-sdk

`turntf-web-sdk` 是 turntf 即时通讯服务的浏览器端 TypeScript SDK。它提供两条能力线：

- **`HTTPClient`**：基于浏览器原生 `fetch` 的 HTTP JSON 客户端，覆盖认证、用户管理、消息收发、附件管理等 REST API。
- **`Client`**：基于浏览器原生 `WebSocket` + Protobuf 的长连接客户端，支持实时消息推送、自动重连、心跳保活、消息确认和游标同步。

本包面向浏览器运行时设计，不依赖 Node.js 特有能力；公开 API、类型命名和协议语义尽量向 `turntf-js` 对齐。

认证支持两条路径：旧的 `nodeId + userId + password` 仍然可用，也可以使用新的 `loginName + password`。`username` 仅作为展示字段，不参与认证。

## 版本说明

`0.2.0` 是一次 breaking upgrade（当前版本 `0.2.2`）：

- 移除了旧的 `TurntfWebClient`
- 移除了 `watchMessagesByUser()` 轮询订阅接口
- 移除了 snake_case 公开类型和 `number | string` 风格 ID
- 主入口切换为 `HTTPClient` / `Client` / 共享类型 / `proto`

如果你还在使用 `0.1.x`，需要按新的 camelCase API 和字符串 ID 迁移。

## 安装

```bash
npm install @tursom/turntf-web-sdk
```

包发布为 ESM 格式，支持浏览器环境通过打包工具（webpack、vite、esbuild 等）直接使用。

## 快速开始

### HTTPClient（HTTP API 客户端）

`HTTPClient` 基于浏览器原生 `fetch`，无需额外依赖。以下示例展示了登录、创建用户和查询消息的基本用法：

```ts
import {
  HTTPClient,
  plainPasswordSync,
  type UserRef
} from "@tursom/turntf-web-sdk";

// 创建客户端，baseUrl 指向 turntf 服务器地址
const client = new HTTPClient("https://turntf.example.com");

// 使用 loginName + password 登录
const token = await client.loginByLoginNameWithPassword(
  "root",
  plainPasswordSync("root-password")
);

// 创建新用户（角色为普通用户）
const user = await client.createUser(token, {
  username: "alice",
  loginName: "alice-login",
  password: plainPasswordSync("alice-password"),
  profileJson: new TextEncoder().encode(JSON.stringify({ display_name: "Alice" })),
  role: "user"
});

// 查询当前用户可通讯的活跃用户
const peers = await client.listUsers(token, {
  name: "ali",
  uid: { nodeId: user.nodeId, userId: user.userId }
});

// 查询目标用户的消息列表
const target: UserRef = { nodeId: user.nodeId, userId: user.userId };
const messages = await client.listMessages(token, target, 20);
console.log("匹配用户数:", peers.length, "消息数量:", messages.length);
```

浏览器环境中 `bcrypt` 哈希计算是同步的（通过 `plainPasswordSync`），因为异步版本 `plainPassword()` 依赖于 `bcryptjs` 的 `hash` 方法，两者在浏览器中均可使用。

### Client（WebSocket 长连接客户端）

`Client` 基于浏览器原生 `WebSocket`，适合需要实时推送的场景。它自动管理连接生命周期，包括自动重连、心跳保活和消息确认：

```ts
import {
  Client,
  DeliveryMode,
  MemoryCursorStore,
  NopHandler,
  plainPasswordSync,
  utf8ToBytes,
  type LoginInfo,
  type Message,
  type Packet
} from "@tursom/turntf-web-sdk";

// 自定义事件处理器
class Handler extends NopHandler {
  override onLogin(info: LoginInfo): void {
    console.log("登录成功", info.user.userId, info.sessionRef.sessionId);
  }

  override onMessage(message: Message): void {
    console.log("收到消息", message.seq, new TextDecoder().decode(message.body));
  }

  override onPacket(packet: Packet): void {
    console.log("收到数据包", packet.packetId, packet.targetSession?.sessionId);
  }
}

const client = new Client({
  baseUrl: "https://turntf.example.com",
  credentials: {
    loginName: "alice-login",
    password: plainPasswordSync("alice-password")
  },
  cursorStore: new MemoryCursorStore(), // 消息游标持久化存储，默认内存存储
  handler: new Handler()
});

// 建立 WebSocket 连接
await client.connect();

// 发送持久化消息
await client.sendMessage(
  { nodeId: "4096", userId: "1025" },
  utf8ToBytes("你好，这是一条持久化消息")
);

// 解析用户在线会话信息，发送瞬时数据包
const resolved = await client.resolveUserSessions({
  nodeId: "8192",
  userId: "1025"
});

const session = resolved.sessions.find((item) => item.transientCapable)?.session;
if (session) {
  await client.sendPacket(
    { nodeId: "8192", userId: "1025" },
    utf8ToBytes("这是一条瞬时消息"),
    DeliveryMode.RouteRetry,
    { targetSession: session }
  );
}

// 关闭连接
await client.close();
```

**浏览器环境注意事项：**

- SDK 依赖浏览器原生 API：`fetch`（`HTTPClient` 用）、`WebSocket`（`Client` 用）、`TextEncoder`/`TextDecoder`（编解码用）、`btoa`/`atob`（Base64 编解码用）。这些 API 在现代浏览器中均已内置。
- `connect()` 默认使用 `wss://` 连接（当 `baseUrl` 为 `https://` 时），确保浏览器安全策略下正常工作。
- 如需要在 Node.js 环境使用 `Client`，需要传入自定义 `fetch` 实现和 `WebSocket` 实现（通过 `ClientOptions.fetch` 字段；WebSocket 实现暂不支持自定义传入，Node.js 环境请使用 `turntf-js`）。

## API 概览

### HTTPClient

`HTTPClient` 封装了 turntf 服务器的 REST API，所有方法均返回 `Promise`，可通过 `RequestOptions` 控制超时和取消。

| 分类 | 方法 | 说明 |
|------|------|------|
| **认证** | `login()` | 使用 nodeId + userId + 密码登录（自动 bcrypt） |
| | `loginWithPassword()` | 使用 nodeId + userId + PasswordInput 登录 |
| | `loginByLoginName()` | 使用 loginName + 密码登录（自动 bcrypt） |
| | `loginByLoginNameWithPassword()` | 使用 loginName + PasswordInput 登录 |
| **用户管理** | `createUser()` | 创建用户 |
| | `createChannel()` | 创建频道（role 默认为 "channel"） |
| | `getUser()` | 获取用户信息 |
| | `listUsers()` | 列出当前用户可通讯的活跃用户，支持 `name`/`uid` 过滤 |
| | `updateUser()` | 更新用户信息（部分更新） |
| | `deleteUser()` | 删除用户 |
| **用户元数据** | `getUserMetadata()` | 获取用户元数据 |
| | `upsertUserMetadata()` | 插入或更新用户元数据 |
| | `deleteUserMetadata()` | 删除用户元数据 |
| | `scanUserMetadata()` | 扫描用户元数据（支持前缀过滤和分页） |
| **频道订阅** | `createSubscription()` | 创建频道订阅 |
| | `subscribeChannel()` | 订阅频道（createSubscription 别名） |
| | `unsubscribeChannel()` | 取消频道订阅 |
| | `listSubscriptions()` | 列出用户的所有频道订阅 |
| **黑名单** | `blockUser()` | 屏蔽（拉黑）用户 |
| | `unblockUser()` | 取消屏蔽（解除拉黑）用户 |
| | `listBlockedUsers()` | 列出用户的黑名单列表 |
| **附件管理** | `upsertAttachment()` | 插入或更新附件关系 |
| | `deleteAttachment()` | 删除附件关系 |
| | `listAttachments()` | 列出附件关系（支持按类型过滤） |
| **消息** | `listMessages()` | 列出用户的消息 |
| | `postMessage()` | 发送持久化消息 |
| | `postPacket()` | 发送瞬时数据包（中继消息） |
| **集群运维** | `listClusterNodes()` | 列出集群中的所有节点 |
| | `listNodeLoggedInUsers()` | 列出指定节点上已登录的用户 |
| | `listEvents()` | 列出集群事件（事件溯源） |
| | `operationsStatus()` | 获取节点操作状态 |
| | `metrics()` | 获取 Prometheus 格式的监控指标 |

### Client

`Client` 基于 WebSocket 提供实时通信，**登录认证在 WebSocket 握手首帧完成**，因此部分方法不需要 `token` 参数。它还暴露 `http` 属性（`HTTPClient` 实例），可直接调用上述 HTTP API。

| 分类 | 方法 | 说明 |
|------|------|------|
| **连接管理** | `connect()` | 建立 WebSocket 连接（自动重连） |
| | `close()` | 关闭连接，停止重连 |
| | `ping()` | 发送心跳 Ping，检测连接状态 |
| | `sessionRef` | 获取当前会话引用（getter） |
| **消息** | `sendMessage()` | 发送持久化消息 |
| | `postMessage()` | sendMessage 别名 |
| | `sendPacket()` | 发送瞬时数据包（支持指定目标会话） |
| | `postPacket()` | sendPacket 别名 |
| | `listMessages()` | 列出用户的消息 |
| **用户管理** | `createUser()` | 创建用户 |
| | `createChannel()` | 创建频道 |
| | `getUser()` | 获取用户信息 |
| | `listUsers()` | 通过 `list_users` RPC 列出当前用户可通讯的活跃用户 |
| | `updateUser()` | 更新用户信息 |
| | `deleteUser()` | 删除用户 |
| **用户元数据** | `getUserMetadata()` | 获取用户元数据 |
| | `upsertUserMetadata()` | 插入或更新用户元数据 |
| | `deleteUserMetadata()` | 删除用户元数据 |
| | `scanUserMetadata()` | 扫描用户元数据 |
| **频道订阅** | `subscribeChannel()` | 订阅频道 |
| | `createSubscription()` | subscribeChannel 别名 |
| | `unsubscribeChannel()` | 取消频道订阅 |
| | `listSubscriptions()` | 列出用户的频道订阅 |
| **黑名单** | `blockUser()` | 屏蔽（拉黑）用户 |
| | `unblockUser()` | 取消屏蔽用户 |
| | `listBlockedUsers()` | 列出黑名单列表 |
| **附件管理** | `upsertAttachment()` | 插入或更新附件 |
| | `deleteAttachment()` | 删除附件 |
| | `listAttachments()` | 列出附件 |
| **会话解析** | `resolveUserSessions()` | 解析用户的在线会话信息 |
| **集群运维** | `listClusterNodes()` | 列出集群节点 |
| | `listNodeLoggedInUsers()` | 列出节点已登录用户 |
| | `listEvents()` | 列出集群事件 |
| | `operationsStatus()` | 获取节点操作状态 |
| | `metrics()` | 获取监控指标 |

### 事件处理器（Handler）

`Client` 通过 `Handler` 接口处理连接生命周期事件：

| 方法 | 触发时机 |
|------|----------|
| `onLogin(info)` | WebSocket 登录成功 |
| `onMessage(message)` | 收到持久化消息 |
| `onPacket(packet)` | 收到瞬时数据包 |
| `onError(error)` | 发生错误 |
| `onDisconnect(error)` | 连接断开 |

可继承 `NopHandler`（空实现）并覆写相关方法。

### 游标存储器（CursorStore）

`CursorStore` 接口用于持久化已接收消息的游标信息，支持断线重连后恢复消息同步：

| 方法 | 说明 |
|------|------|
| `loadSeenMessages()` | 加载已见消息游标列表，连接时发送给服务器去重 |
| `saveMessage(message)` | 保存接收到的消息 |
| `saveCursor(cursor)` | 保存消息游标 |

默认使用 `MemoryCursorStore`（内存存储，页面刷新后丢失）。可自定义实现 `CursorStore` 接口使用 `localStorage` 或 `IndexedDB` 做持久化。

### 密码工具

SDK 提供了三种创建 `PasswordInput` 的方式：

| 函数 | 说明 |
|------|------|
| `plainPassword(plain)` | 异步 bcrypt 哈希（async） |
| `plainPasswordSync(plain)` | 同步 bcrypt 哈希（浏览器环境推荐） |
| `hashedPassword(hash)` | 使用已有的 bcrypt 哈希值 |

辅助函数：`hashPassword()`、`validatePassword()`、`passwordWireValue()`。

### 编解码工具

| 函数 | 说明 |
|------|------|
| `utf8ToBytes(str)` | UTF-8 字符串转 Uint8Array |
| `bytesToUtf8(bytes)` | Uint8Array 转 UTF-8 字符串 |
| `bytesToBase64(bytes)` | Uint8Array 转 Base64 字符串 |
| `base64ToBytes(str)` | Base64 字符串转 Uint8Array |
| `parseJson(text)` | JSON 解析（支持 BigInt） |
| `stringifyJson(value)` | JSON 序列化（支持 BigInt） |

### 类型系统

所有 64 位 ID 都以十进制字符串暴露，例如 `nodeId`、`userId`、`seq`、`packetId`。二进制字段统一为 `Uint8Array`。

主要类型：
- `User`、`LoggedInUser` — 用户信息；`User.loginName` 在普通用户列出他人时可能为空字符串
- `Message` — 持久化消息（包含 `recipient`、`sender`、`body` 等）
- `Packet` — 瞬时数据包（包含 `deliveryMode`、`targetSession` 等）
- `RelayAccepted` — 中继确认
- `Attachment`、`Subscription`、`BlacklistEntry` — 关系管理
- `UserMetadata` — 用户元数据
- `Event` — 集群事件（事件溯源）
- `ClusterNode` — 集群节点
- `OperationsStatus`、`PeerStatus` — 集群运维状态
- `Credentials` — 认证凭据联合类型（`UserCredentials` | `LoginNameCredentials`）
- `UserRef` — 用户引用 `{ nodeId, userId }`
- `SessionRef` — 会话引用 `{ servingNodeId, sessionId }`
- `MessageCursor` — 消息游标 `{ nodeId, seq }`
- `DeliveryMode` — 投递模式常量
- `AttachmentType` — 附件类型常量

### 错误类型

| 错误类 | 说明 |
|--------|------|
| `TurntfError` | 所有 SDK 错误基类 |
| `ServerError` | 服务器返回错误，包含 `code`、`requestId` |
| `ConnectionError` | WebSocket 连接错误，包含 `op` 和 `cause` |
| `ProtocolError` | 协议数据格式错误 |
| `ClosedError` | 客户端已关闭后调用方法 |
| `NotConnectedError` | 未连接时执行需要连接的操作 |
| `DisconnectedError` | WebSocket 运行中断开 |

### Proto

可以直接使用生成的 protobuf 类型与编解码器：

```ts
import { proto } from "@tursom/turntf-web-sdk";

const envelope = proto.ClientEnvelope.create({
  body: {
    oneofKind: "ping",
    ping: { requestId: "1" }
  }
});
```

原始 `.proto` 文件也会一起发布：

```ts
import protoPath from "@tursom/turntf-web-sdk/proto/client.proto";
```

### 共享语义

- `User.profileJson`、`Attachment.configJson`、`Event.eventJson` 都是原始 JSON 字节（`Uint8Array`）
- `updateUser({ loginName: "" })` 表示解绑登录名；缺席表示保持不变
- `Client` 收到持久化消息时，固定按以下顺序处理：`saveMessage -> saveCursor -> AckMessage -> handler.onMessage`
- `AckMessage` 只影响当前连接内去重；真正的重连恢复依赖 `seenMessages`（由 `CursorStore` 提供）

## 与 turntf-js 的关系

`turntf-js` 是 turntf 的 Node.js SDK，面向服务端运行环境。`turntf-web-sdk` 是其浏览器端等价实现，两者在 API 设计和类型命名上保持一致，主要区别：

| 方面 | turntf-js | turntf-web-sdk |
|------|-----------|-----------------|
| 运行时 | Node.js | 浏览器 |
| HTTP 客户端 | 基于 `undici` / `node:http` | 基于浏览器 `fetch` |
| WebSocket | 基于 `ws` 库 | 基于浏览器原生 `WebSocket` |
| 密码处理 | 可委托给服务端 | 浏览器侧通过 `bcryptjs` 完成 |
| 发布名 | `turntf-js` | `@tursom/turntf-web-sdk` |

如果你需要在 Node.js 服务端（如 NestJS、Express 等）中使用，请使用 `turntf-js`。

## 文档导航

- [turntf-js 主仓库](https://github.com/tursom/turntf-js) — Node.js SDK、服务端框架
- [turntf-web-sdk Issues](https://github.com/tursom/turntf-web-sdk/issues) — 问题反馈
- [turntf-web 参考实现](https://github.com/tursom/turntf-web) — 基于此 SDK 构建的 Web 应用

## 构建与测试

```bash
# 安装依赖
npm install

# 生成 Protobuf 代码
npm run gen:proto

# 类型检查
npm run typecheck

# 运行测试
npm test

# 构建
npm run build
```

SDK 使用 `vitest` 作为测试框架，使用 `@protobuf-ts/plugin` 从 `.proto` 文件生成 TypeScript 代码。
