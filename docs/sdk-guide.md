# turntf-web-sdk 使用指南

## 安装

```bash
npm install @tursom/turntf-web-sdk
```

本包为纯 ESM 包，浏览器环境需要配合打包工具（Vite、Webpack、esbuild 等）使用。

## HTTPClient 使用

`HTTPClient` 封装了 turntf 后端的 HTTP JSON API，适用于不需要实时推送的场景。

### 创建客户端

```typescript
import { HTTPClient } from "@tursom/turntf-web-sdk";

// baseUrl 可以是相对路径（通过反向代理访问）或绝对路径
const client = new HTTPClient("/api");
// 或
const client = new HTTPClient("http://localhost:8080");
```

### 登录与用户管理

```typescript
import { plainPasswordSync } from "@tursom/turntf-web-sdk";

// 使用 nodeId + userId 登录（SDK 会自动做 bcrypt 哈希）
const token = await client.loginWithPassword(
  "4096",        // nodeId
  "1",           // userId
  plainPasswordSync("root-password")
);

// 或者改用 loginName + password 登录
const tokenByLoginName = await client.loginByLoginNameWithPassword(
  "root",
  plainPasswordSync("root-password")
);

// 创建新用户
const newUser = await client.createUser(token, {
  username: "alice",
  loginName: "alice-login",
  password: plainPasswordSync("alice-password"),
  profileJson: new TextEncoder().encode(JSON.stringify({ displayName: "Alice" })),
  role: "user"
});

// 获取用户信息
const user = await client.getUser(token, {
  nodeId: "4096",
  userId: "1025"
});

// 更新用户
await client.updateUser(token, { nodeId: "4096", userId: "1025" }, {
  username: "alice_new",
  loginName: ""   // 传空串表示解绑登录名；不传表示保持不变
});
```

### 消息管理

```typescript
// 发消息
const message = await client.postMessage(
  token,
  { nodeId: "4096", userId: "1025" },
  new TextEncoder().encode("你好，世界！")
);

// 列出最近消息
const messages = await client.listMessages(
  token,
  { nodeId: "4096", userId: "1025" },
  20  // limit，0 表示不限
);

// 遍历消息
for (const msg of messages) {
  const text = new TextDecoder().decode(msg.body);
  console.log(`[${msg.seq}] ${text}`);
}
```

### 频道订阅

```typescript
// 订阅频道
const subscription = await client.subscribeChannel(
  token,
  { nodeId: "4096", userId: "1025" },  // 订阅者
  { nodeId: "8192", userId: "1" }      // 频道
);

// 列出订阅
const subs = await client.listSubscriptions(
  token,
  { nodeId: "4096", userId: "1025" }
);

// 取消订阅
await client.unsubscribeChannel(
  token,
  { nodeId: "4096", userId: "1025" },
  { nodeId: "8192", userId: "1" }
);
```

### 黑名单

```typescript
// 拉黑用户
await client.blockUser(
  token,
  { nodeId: "4096", userId: "1025" },  // 操作者
  { nodeId: "4096", userId: "2048" }   // 被拉黑的用户
);

// 查看黑名单
const blocked = await client.listBlockedUsers(
  token,
  { nodeId: "4096", userId: "1025" }
);

// 取消拉黑
await client.unblockUser(
  token,
  { nodeId: "4096", userId: "1025" },
  { nodeId: "4096", userId: "2048" }
);
```

### 错误处理

```typescript
import {
  ProtocolError,
  ConnectionError,
  TurntfError
} from "@tursom/turntf-web-sdk";

try {
  const user = await client.getUser(token, { nodeId: "0", userId: "0" });
} catch (error) {
  if (error instanceof ProtocolError) {
    console.error("协议错误:", error.protocolMessage);
  } else if (error instanceof ConnectionError) {
    console.error("连接错误:", error.op, error.cause);
  } else if (error instanceof TurntfError) {
    console.error("SDK 错误:", error.message);
  }
}
```

### 取消请求

所有 HTTP 方法都接受可选的 `RequestOptions`，支持 `AbortSignal` 和超时：

```typescript
const controller = new AbortController();

// 5 秒后取消
setTimeout(() => controller.abort(), 5000);

try {
  await client.listMessages(token, target, 20, {
    signal: controller.signal,
    timeoutMs: 3000  // 3 秒超时
  });
} catch (error) {
  if ((error as Error).name === "AbortError") {
    console.log("请求被取消");
  }
}
```

## Client（WebSocket）使用

`Client` 封装了基于 WebSocket 的实时长连接，适用于需要实时接收推送的场景。

### 创建客户端

```typescript
import {
  Client,
  MemoryCursorStore,
  NopHandler,
  plainPasswordSync,
  type LoginInfo,
  type Message,
  type Packet
} from "@tursom/turntf-web-sdk";

// 定义事件处理器
class MyHandler extends NopHandler {
  override onLogin(info: LoginInfo): void {
    console.log("登录成功:", info.user.userId, info.sessionRef.sessionId);
  }

  override onMessage(message: Message): void {
    const text = new TextDecoder().decode(message.body);
    console.log("收到消息:", message.seq, text);
  }

  override onPacket(packet: Packet): void {
    console.log("收到瞬态消息:", packet.packetId);
  }

  override onDisconnect(error: unknown): void {
    console.log("连接断开:", error);
  }

  override onError(error: unknown): void {
    console.error("错误:", error);
  }
}

// 创建客户端实例
const client = new Client({
  baseUrl: "http://localhost:8080",
  credentials: {
    loginName: "alice-login",
    password: plainPasswordSync("alice-password")
  },
  cursorStore: new MemoryCursorStore(),  // 生产环境建议实现 IndexedDB 持久化
  handler: new MyHandler(),
  reconnect: true,           // 启用自动重连
  ackMessages: true,         // 自动 ack 持久化消息
  pingIntervalMs: 30000,     // 30 秒心跳
  requestTimeoutMs: 10000    // RPC 请求超时
});
```

### 连接与断开

```typescript
// 建立连接（自动处理登录握手）
await client.connect();

// 发送持久化消息
const msg = await client.sendMessage(
  { nodeId: "4096", userId: "1025" },
  new TextEncoder().encode("hello")
);

// 发送瞬态消息
const relay = await client.sendPacket(
  { nodeId: "8192", userId: "1025" },
  new TextEncoder().encode("ephemeral"),
  "route_retry"  // 或 "best_effort"
);

// 关闭连接
await client.close();
```

### 使用 `sendPacket` 指定目标会话

```typescript
// 先解析用户所在会话
const result = await client.resolveUserSessions({
  nodeId: "8192",
  userId: "1025"
});

// 找到支持瞬态消息的会话
const session = result.sessions.find(s => s.transientCapable)?.session;
if (session) {
  await client.sendPacket(
    { nodeId: "8192", userId: "1025" },
    new TextEncoder().encode("定向消息"),
    "route_retry",
    { targetSession: session }
  );
}
```

### 通过 WebSocket 执行管理操作

`Client` 也提供与 `HTTPClient` 相同签名的方法，这些请求通过 WebSocket 连接以 RPC 方式发送：

```typescript
// 创建用户（通过 WebSocket RPC）
const user = await client.createUser({
  username: "bob",
  loginName: "bob-login",
  password: plainPasswordSync("bob-password"),
  role: "user"
});

// 查询集群节点
const nodes = await client.listClusterNodes();

// 查询运维状态
const status = await client.operationsStatus();
```

## 类型系统

### ID 类型

所有 64 位数字 ID 均以 `string` 形式暴露，避免 JavaScript `number` 的精度丢失：

```typescript
interface UserRef {
  nodeId: string;  // 十进制字符串，如 "4096"
  userId: string;  // 十进制字符串，如 "1025"
}
```

### 二进制数据

所有二进制字段使用 `Uint8Array`：

```typescript
interface Message {
  body: Uint8Array;
  // ...
}
```

### 密码输入

```typescript
interface PasswordInput {
  source: "plain" | "hashed";
  encoded: string;  // bcrypt 哈希值
}
```

创建方式：
- `plainPasswordSync(plain)`：同步计算 bcrypt 哈希。
- `plainPassword(plain)`：异步计算 bcrypt 哈希。
- `hashedPassword(hash)`：直接使用已有的 bcrypt 哈希。

## Proto 类型访问

直接使用生成的 protobuf 类型：

```typescript
import { proto } from "@tursom/turntf-web-sdk";

// 构建协议消息
const envelope = proto.ClientEnvelope.create({
  body: {
    oneofKind: "ping",
    ping: { requestId: "1" }
  }
});

// 序列化
const bytes = proto.ClientEnvelope.toBinary(envelope);

// 反序列化
const decoded = proto.ServerEnvelope.fromBinary(bytes);
```

也可以直接引用 proto 源文件：

```typescript
import protoPath from "@tursom/turntf-web-sdk/proto/client.proto";
// 注意：需要打包工具支持导入 .proto 文件
```

## 共享语义要点

1. **ID 格式**：所有 ID 为十进制字符串，如 `"4096"`、`"18446744073709551615"`。
2. **消息顺序**：收到持久化消息后严格按 `saveMessage -> saveCursor -> AckMessage -> handler.onMessage` 顺序处理。
3. **Ack 语义**：`AckMessage` 仅用于当前连接生命周期内的去重；真正的断线重连恢复依赖 `seenMessages` 游标列表。
4. **自动重连**：默认启用，策略为指数退避（初始 1 秒，最大 30 秒）。认证失败（`unauthorized`）时不会重试。
5. **会话隔离**：每个 `Client` 实例维护独立的 WebSocket 连接和会话状态，多次调用 `connect()` 不会创建多个连接。
