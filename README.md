# turntf-web-sdk

`turntf-web-sdk` 是 turntf 的浏览器版 TypeScript SDK，提供两条能力线：

- `HTTPClient`：基于 `fetch` 的 HTTP JSON 客户端
- `Client`：基于浏览器原生 `WebSocket` + Protobuf 的长连接客户端

本包面向浏览器运行时设计，不依赖 Node 运行时能力；公开 API、类型命名和协议语义尽量向 `turntf-js` 对齐。

## 版本说明

`0.2.0` 是一次 breaking upgrade：

- 移除了旧的 `TurntfWebClient`
- 移除了 `watchMessagesByUser()` 轮询订阅接口
- 移除了 snake_case 公开类型和 `number | string` 风格 ID
- 主入口切换为 `HTTPClient` / `Client` / 共享类型 / `proto`

如果你还在使用 `0.1.x`，需要按新的 camelCase API 和字符串 ID 迁移。

## 主要能力

`HTTPClient` 覆盖：

- 登录：`login()`、`loginWithPassword()`
- 用户：`createUser()`、`createChannel()`、`getUser()`、`updateUser()`、`deleteUser()`
- 关系：`createSubscription()`、`subscribeChannel()`、`unsubscribeChannel()`、`listSubscriptions()`
- 黑名单：`blockUser()`、`unblockUser()`、`listBlockedUsers()`
- 附件：`upsertAttachment()`、`deleteAttachment()`、`listAttachments()`
- 消息：`listMessages()`、`postMessage()`、`postPacket()`
- 运维：`listClusterNodes()`、`listNodeLoggedInUsers()`、`listEvents()`、`operationsStatus()`、`metrics()`

`Client` 覆盖：

- WebSocket 首帧登录
- 自动重连与重新登录
- `sessionRef`
- `seenMessages` / `CursorStore`
- `sendMessage()` / `sendPacket()`
- `resolveUserSessions()`
- 持久化消息自动 `ack`
- 同一连接上的管理 / 查询 RPC

## 安装

```bash
npm install @tursom/turntf-web-sdk
```

## 快速开始

### `HTTPClient`

```ts
import {
  HTTPClient,
  plainPasswordSync,
  type UserRef
} from "@tursom/turntf-web-sdk";

const client = new HTTPClient("/api");

const token = await client.loginWithPassword(
  "4096",
  "1",
  plainPasswordSync("root-password")
);

const user = await client.createUser(token, {
  username: "alice",
  password: plainPasswordSync("alice-password"),
  profileJson: new TextEncoder().encode("{\"display_name\":\"Alice\"}"),
  role: "user"
});

const target: UserRef = { nodeId: user.nodeId, userId: user.userId };
const messages = await client.listMessages(token, target, 20);
console.log(messages.length);
```

### `Client`

```ts
import {
  Client,
  DeliveryMode,
  MemoryCursorStore,
  NopHandler,
  plainPasswordSync,
  type LoginInfo,
  type Message,
  type Packet
} from "@tursom/turntf-web-sdk";

class Handler extends NopHandler {
  override onLogin(info: LoginInfo): void {
    console.log("login ok", info.user.userId, info.sessionRef.sessionId);
  }

  override onMessage(message: Message): void {
    console.log("message", message.seq, new TextDecoder().decode(message.body));
  }

  override onPacket(packet: Packet): void {
    console.log("packet", packet.packetId, packet.targetSession?.sessionId);
  }
}

const client = new Client({
  baseUrl: "http://127.0.0.1:8080",
  credentials: {
    nodeId: "4096",
    userId: "1025",
    password: plainPasswordSync("alice-password")
  },
  cursorStore: new MemoryCursorStore(),
  handler: new Handler()
});

await client.connect();

await client.sendMessage(
  { nodeId: "4096", userId: "1025" },
  new TextEncoder().encode("hello")
);

const resolved = await client.resolveUserSessions({
  nodeId: "8192",
  userId: "1025"
});

const session = resolved.sessions.find((item) => item.transientCapable)?.session;
if (session) {
  await client.sendPacket(
    { nodeId: "8192", userId: "1025" },
    new TextEncoder().encode("ephemeral"),
    DeliveryMode.RouteRetry,
    { targetSession: session }
  );
}

await client.close();
```

## 共享语义

- 所有 64 位 ID 都以十进制字符串暴露，例如 `nodeId`、`userId`、`seq`、`packetId`
- 二进制字段统一为 `Uint8Array`
- `User.profileJson`、`Attachment.configJson`、`Event.eventJson` 都是原始 JSON 字节
- `Client` 收到持久化消息时，固定按 `saveMessage -> saveCursor -> AckMessage -> handler.onMessage` 顺序处理
- `AckMessage` 只影响当前连接内去重；真正的重连恢复依赖 `seenMessages`

## Proto

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

原始 proto 文件也会一起发布：

```ts
import protoPath from "@tursom/turntf-web-sdk/proto/client.proto";
```

## 本地开发

```bash
npm install
npm run gen:proto
npm run typecheck
npm test
npm run build
```
