# WebSocket 实时客户端流程

本文档详细说明 `Client` 类的 WebSocket 连接生命周期、消息处理流程和内部状态机。

## 连接生命周期

### 1. 连接建立（`connect()`）

```
connect()
  ├── 检查 closed 状态（已关闭则抛出 ClosedError）
  ├── 检查已连接状态（已连接则直接返回）
  ├── 创建 connectWaiter（Deferred<void>）
  ├── 启动运行循环（ensureRunLoop → run）
  │     └── run() 进入 reconnect 循环
  │           └── 调用 connectAndServe()
  └── 等待 connectWaiter 被 resolve/reject
```

### 2. 握手流程（`connectAndServe()`）

```
connectAndServe()
  ├── 加载已见消息游标（cursorStore.loadSeenMessages()）
  ├── 建立 WebSocket 连接（dial()）
  │     ├── 使用 globalThis.WebSocket 创建连接
  │     ├── 设置 binaryType = "arraybuffer"
  │     ├── URL 自动转换：http → ws, https → wss
  │     └── 路径选项：
  │           ├── realtime=true  → /ws/realtime
  │           └── realtime=false → /ws/client
  ├── 发送 LoginRequest（Protobuf 编码）
  │     ├── 用户凭证（nodeId + userId）
  │     ├── bcrypt 哈希密码
  │     ├── seenMessages 游标列表（用于断线恢复）
  │     └── transientOnly 标记
  ├── 等待 LoginResponse
  │     ├── 成功：提取 LoginInfo（user + protocolVersion + sessionRef）
  │     ├── 失败（error code="unauthorized"）：停止重连，抛出 ServerError
  │     └── 其他错误：抛出 ServerError
  ├── 设置连接状态
  │     ├── this.socket = QueuedWebSocket
  │     ├── this.currentSessionRef = sessionRef
  │     ├── this.connected = true
  │     └── resolve connectWaiter
  ├── 调用 handler.onLogin(info)
  ├── 启动心跳循环（pingLoop）
  │     └── 每 pingIntervalMs 发送一次 Ping
  └── 进入读取循环（readLoop）
        └── 持续等待并处理服务端消息
```

### 3. 断开与重连

```
断开触发条件：
  ├── WebSocket 触发 close 事件
  ├── WebSocket 触发 error 事件
  ├── 心跳 Ping 超时
  └── 客户端主动调用 close()

重连流程（在 run() 循环中）：
  └── 判断 shouldRetry(error)
        ├── client.closed → 不重试
        ├── stopReconnect（unauthorized）→ 不重试
        ├── reconnectEnabled=false → 不重试
        └── 其他 → 进入重连等待
              ├── 调用 handler.onDisconnect(error)
              ├── 等待 delayMs（初始 1 秒，指数退避，最大 30 秒）
              ├── 调用 connectAndServe() 重新建立连接
              └── 成功后将 delayMs 重置为初始值

失败处理：
  ├── rejectConnectWaiter(error) — 通知 connect() 调用者
  └── failAllPending(error) — 拒绝所有待处理的 RPC 请求
```

## 消息处理流程

### 持久化消息（Message）

```
收到 messagePushed
  ├── messageFromProto() 转换为 SDK Message 类型
  ├── persistAndDispatchMessage(message)
  │     ├── cursorStore.saveMessage(message)    — 保存消息内容
  │     ├── cursorStore.saveCursor(cursor)       — 保存游标
  │     ├── 如果 ackMessages=true:
  │     │     └── 发送 AckMessage(cursor)        — 通知服务端已确认
  │     └── handler.onMessage(message)           — 通知业务层
  └── 错误处理
        └── ack 发送失败（ClosedError/NotConnectedError 忽略，其他错误调用 handler.onError）
```

**保证的顺序**：`saveMessage → saveCursor → AckMessage → onMessage`。

### 瞬态消息（Packet）

```
收到 packetPushed
  ├── packetFromProto() 转换为 SDK Packet 类型
  └── handler.onPacket(packet)
```

瞬态消息不需要持久化，也不需要 ack。

### RPC 请求/响应

RPC 请求流：
```
sendEnvelope (ClientEnvelope)
  ├── 生成唯一 requestId（自增 BigInt → 字符串）
  ├── 注册 pending Deferred
  ├── 创建复合 AbortSignal（合并 timeout + 外部 signal）
  ├── Protobuf 序列化
  ├── 写入 WebSocket（通过 writeChain 保证顺序）
  └── 等待 pending Deferred resolve/reject

处理响应：
  └── handleServerEnvelope()
        ├── 根据 oneofKind 分发
        ├── 找到对应的 requestId
        ├── resolvePending(requestId, value)
        └── 超时或取消时 rejectPending(requestId, error)
```

## 心跳机制

```
pingLoop()
  ├── 每 pingIntervalMs（默认 30 秒）发送 Ping 请求
  ├── 等待 Pong 响应（超时时间 = requestTimeoutMs，默认 10 秒）
  ├── 超时后：
  │     ├── 如果不是连接关闭相关错误 → 调用 handler.onError
  │     └── 连接本身不受影响（心跳失败不主动断开）
  └── 客户端关闭或连接断开时退出循环
```

## 消息写入保证

`Client` 使用 `writeChain` 保证 Protobuf 帧的写入顺序：

```
writeProto(socket, env)
  ├── 序列化为二进制
  ├── 追加到 writeChain：前一个写入完成后才执行当前写入
  └── 异常时转换为 ConnectionError("write", cause)
```

这确保了多 goroutine 风格下的并发安全（虽然 JS 是单线程，但异步操作可能导致交错的 write 调用）。

## CursorStore 接口

`CursorStore` 是游标持久化的抽象层：

```typescript
interface CursorStore {
  loadSeenMessages(): Promise<MessageCursor[]> | MessageCursor[];
  saveMessage(message: Message): Promise<void> | void;
  saveCursor(cursor: MessageCursor): Promise<void> | void;
}
```

### MemoryCursorStore

默认实现，数据存储在内存中：

- `loadSeenMessages()`：返回所有已保存的游标的副本。
- `saveMessage(message)`：按键 `"nodeId:seq"` 存储消息副本。
- `saveCursor(cursor)`：如果该游标尚未存在，追加到有序列表中。

浏览器生产环境建议实现 `CursorStore` 接口并使用 IndexedDB 持久化，以便页面刷新后恢复已见消息。

### 断线恢复流程

```
1. connect() 调用 connectAndServe()
2. connectAndServe() 调用 cursorStore.loadSeenMessages()
3. 获取 MessageCursor[] 列表（已确认收到的消息游标）
4. 在 LoginRequest 中发送 seenMessages 给服务端
5. 服务端根据 seenMessages 过滤，只推送未确认的消息
6. 新连接建立后，仅收到断线期间错过的增量消息
```

## 发送消息与发送瞬态消息的区别

| 特性 | sendMessage/postMessage | sendPacket/postPacket |
|------|------------------------|----------------------|
| 消息类型 | 持久化（Persistent） | 瞬态（Transient） |
| deliveryKind | `PERSISTENT` | `TRANSIENT` |
| 存储 | 服务端持久化存储 | 不存储 |
| ack | 自动 ack | 不需要 |
| 重连恢复 | 通过 seenMessages 恢复 | 不恢复 |
| 返回值 | `Message`（含 seq） | `RelayAccepted`（含 packetId） |
| 目标选择 | 指定 UserRef | 指定 UserRef + 可选 targetSession |

## 连接状态枚举

| 状态 | 含义 | 触发条件 |
|------|------|----------|
| initial | 初始状态 | `new Client()` 后 |
| connecting | 正在连接 | `connect()` 调用，WebSocket 连接中 |
| connected | 已连接 | 收到 LoginResponse，set connected=true |
| disconnected | 断开 | WebSocket close/error，set connected=false |
| closed | 已关闭 | `close()` 调用，lifecycleAbort.abort() |

**注意**：当前实现没有显式的状态枚举，而是通过组合 boolean 字段推断：`this.connected`、`this.closed`、`this.socket`、`this.connectingSocket`。
