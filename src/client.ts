import {
  ClientDeliveryKind,
  ClientEnvelope as ProtoClientEnvelope,
  ClientMessageSyncMode,
  ServerEnvelope as ProtoServerEnvelope,
  type LoginRequest as ProtoLoginRequest,
  type SendMessageResponse as ProtoSendMessageResponse,
  type UpsertUserMetadataRequest as ProtoUpsertUserMetadataRequest,
  type UpdateUserRequest as ProtoUpdateUserRequest
} from "./generated/client";
import {
  ClosedError,
  ConnectionError,
  DisconnectedError,
  NotConnectedError,
  ProtocolError,
  ServerError
} from "./errors";
import { HTTPClient } from "./http";
import {
  attachmentFromProto,
  attachmentTypeToProto,
  clusterNodesFromProto,
  cursorToProto,
  deliveryModeToProto,
  eventsFromProto,
  loggedInUsersFromProto,
  messageFromProto,
  operationsStatusFromProto,
  packetFromProto,
  relayAcceptedFromProto,
  resolveUserSessionsFromProto,
  scanUserMetadataResultFromProto,
  sessionRefFromProto,
  sessionRefToProto,
  userFromProto,
  userMetadataFromProto,
  userRefToProto
} from "./mapping";
import { passwordWireValue, validatePassword, type PasswordInput } from "./password";
import { type CursorStore, MemoryCursorStore } from "./store";
import type {
  Attachment,
  AttachmentType,
  BlacklistEntry,
  ClusterNode,
  Credentials,
  CreateUserRequest,
  DeleteUserResult,
  DeliveryMode,
  Event as TurntfEvent,
  ListUsersRequest,
  LoggedInUser,
  LoginInfo,
  Message,
  OperationsStatus,
  Packet,
  RelayAccepted,
  RequestOptions,
  ResolveUserSessionsResult,
  ScanUserMetadataRequest,
  ScanUserMetadataResult,
  SendPacketOptions,
  SessionRef,
  Subscription,
  UpdateUserRequest,
  User,
  UserMetadata,
  UpsertUserMetadataRequest,
  UserRef
} from "./types";
import { abortReason, createDeferred, ensureConnectionError, mergeAbortSignals, sleep, type Deferred } from "./utils";
import { Relay } from "./relay";
import {
  cursorForMessage,
  isZeroUserRef,
  toRequiredWireInteger,
  toWireInteger,
  validateCredentials,
  validateDeliveryMode,
  validateLoginName,
  validateListUsersRequest,
  validateSessionRef,
  validateUserMetadataKey,
  validateUserMetadataValuePolicy,
  validateUserMetadataScanRequest,
  validateUserRef
} from "./validation";

/**
 * 事件处理器接口。
 * 用于处理 WebSocket 连接生命周期中的各种事件。
 * 如果未提供自定义实现，将使用 {@link NopHandler}（空实现）。
 */
export interface Handler {
  /**
   * 登录成功后触发。
   * @param info - 登录信息，包含用户信息、协议版本和会话引用
   */
  onLogin(info: LoginInfo): void | Promise<void>;

  /**
   * 收到新消息时触发。
   * @param message - 接收到的消息对象
   */
  onMessage(message: Message): void | Promise<void>;

  /**
   * 收到瞬时数据包时触发。
   * @param packet - 接收到的数据包对象
   */
  onPacket(packet: Packet): void | Promise<void>;

  /**
   * 发生错误时触发。
   * @param error - 错误对象
   */
  onError(error: unknown): void | Promise<void>;

  /**
   * 与服务器的连接断开时触发。
   * @param error - 导致断开的原因
   */
  onDisconnect(error: unknown): void | Promise<void>;
}

/**
 * 空事件处理器。
 * 所有方法的默认实现均为空操作，适用于只关注部分事件的场景。
 * 建议继承此类并覆写需要处理的事件方法。
 */
export class NopHandler implements Handler {
  onLogin(_info: LoginInfo): void {}
  onMessage(_message: Message): void {}
  onPacket(_packet: Packet): void {}
  onError(_error: unknown): void {}
  onDisconnect(_error: unknown): void {}
}

/**
 * 客户端配置选项。
 *
 * 用于创建 {@link Client} 实例的配置参数，包含认证凭据、连接参数、
 * 事件处理器和存储实现等。
 *
 * @example
 * const client = new Client({
 *   baseUrl: "https://turntf.example.com",
 *   credentials: { nodeId: "1", userId: "1001", password: await plainPassword("secret") },
 *   handler: { onMessage(msg) { console.log(msg); } }
 * });
 */
export interface ClientOptions {
  /** 服务器基础 URL */
  baseUrl: string;

  /** 认证凭据（支持 nodeId+userId 或 loginName 两种方式） */
  credentials: Credentials;

  /** 可选的游标存储器，用于持久化消息同步状态。默认使用 {@link MemoryCursorStore} */
  cursorStore?: CursorStore;

  /** 可选的事件处理器，用于处理登录、消息等事件。默认使用 {@link NopHandler} */
  handler?: Handler;

  /** 可选的 fetch 实现，用于 Node.js 等没有全局 fetch 的环境 */
  fetch?: typeof fetch;

  /** 是否启用自动重连。默认为 true */
  reconnect?: boolean;

  /** 初始重连延迟（毫秒）。默认为 1000ms */
  initialReconnectDelayMs?: number;

  /** 最大重连延迟（毫秒）。默认为 30000ms */
  maxReconnectDelayMs?: number;

  /** 心跳 Ping 间隔（毫秒）。默认为 30000ms */
  pingIntervalMs?: number;

  /** RPC 请求超时时间（毫秒）。默认为 10000ms */
  requestTimeoutMs?: number;

  /** 是否自动确认（ACK）已接收的消息。默认为 true */
  ackMessages?: boolean;

  /** 是否仅接收瞬时消息（跳过持久化消息的同步）。默认为 false */
  transientOnly?: boolean;

  /** 是否使用实时 WebSocket 端点（/ws/realtime）。默认为 false 使用 /ws/client */
  realtimeStream?: boolean;
}

interface ServeResult {
  readonly connected: boolean;
  readonly error: unknown;
}

interface Frame {
  readonly data: unknown;
  readonly isBinary: boolean;
}

/**
 * turntf WebSocket 客户端。
 * 提供基于 WebSocket 的实时通信功能，包括消息收发、数据包中继、
 * 用户管理、频道订阅、元数据管理等。
 *
 * 客户端会自动管理 WebSocket 连接，包括自动重连、心跳保活、
 * 消息确认和游标同步。
 *
 * @example
 * const client = new Client({
 *   baseUrl: "https://turntf.example.com",
 *   credentials: { loginName: "user1", password: await plainPassword("pass") },
 *   handler: {
 *     onMessage(msg) { console.log("收到消息:", msg); },
 *     onPacket(pkt) { console.log("收到数据包:", pkt); }
 *   }
 * });
 * await client.connect();
 * await client.sendMessage({ nodeId: "1", userId: "2" }, utf8ToBytes("你好"));
 */
export class Client {
  /** HTTP API 客户端实例 */
  readonly http: HTTPClient;

  private readonly credentials: Credentials;
  private readonly cursorStore: CursorStore;
  private readonly handler: Handler;
  private readonly reconnectEnabled: boolean;
  private readonly initialReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly pingIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly ackMessages: boolean;
  private readonly transientOnly: boolean;
  private readonly realtimeStream: boolean;

  private readonly lifecycleAbort = new AbortController();
  private readonly pending = new Map<string, Deferred<unknown>>();

  private requestId = 0n;
  private writeChain: Promise<void> = Promise.resolve();
  private socket: QueuedWebSocket | undefined;
  private connectingSocket: QueuedWebSocket | undefined;
  private pingTask: Promise<void> | undefined;
  private runTask: Promise<void> | undefined;
  private connectWaiter: Deferred<void> | undefined;
  private currentSessionRef: SessionRef | undefined;
  private connected = false;
  private closed = false;
  private stopReconnect = false;
  private _relay: Relay | undefined;

  /**
   * 创建一个 Client 实例。
   * 注意：创建后需要调用 {@link connect} 方法建立 WebSocket 连接。
   *
   * @param options - 客户端配置选项
   * @throws 如果 baseUrl 为空、凭据无效或密码无效则抛出错误
   */
  constructor(options: ClientOptions) {
    if (options.baseUrl.trim() === "") {
      throw new Error("baseUrl is required");
    }
    validateCredentials(options.credentials, "credentials");
    validatePassword(options.credentials.password);

    this.http = new HTTPClient(
      options.baseUrl,
      options.fetch == null ? {} : { fetch: options.fetch }
    );
    this.credentials = usesLoginNameCredentials(options.credentials)
      ? {
          loginName: options.credentials.loginName,
          password: options.credentials.password
        }
      : {
          nodeId: options.credentials.nodeId,
          userId: options.credentials.userId,
          password: options.credentials.password
        };
    this.cursorStore = options.cursorStore ?? new MemoryCursorStore();
    this.handler = options.handler ?? new NopHandler();
    this.reconnectEnabled = options.reconnect ?? true;
    this.initialReconnectDelayMs = positiveOrDefault(options.initialReconnectDelayMs, 1_000);
    this.maxReconnectDelayMs = positiveOrDefault(options.maxReconnectDelayMs, 30_000);
    this.pingIntervalMs = positiveOrDefault(options.pingIntervalMs, 30_000);
    this.requestTimeoutMs = positiveOrDefault(options.requestTimeoutMs, 10_000);
    this.ackMessages = options.ackMessages ?? true;
    this.transientOnly = options.transientOnly ?? false;
    this.realtimeStream = options.realtimeStream ?? false;
  }

  /**
   * 获取服务器基础 URL。
   */
  get baseUrl(): string {
    return this.http.baseUrl;
  }

  /**
   * 获取当前会话引用。
   * 只有在成功连接后才会有会话引用，断开后返回 undefined。
   *
   * @returns 当前会话引用的副本，未连接时返回 undefined
   */
  get sessionRef(): SessionRef | undefined {
    if (this.currentSessionRef == null) {
      return undefined;
    }
    return { ...this.currentSessionRef };
  }

  /**
   * 获取或创建与当前客户端关联的 Relay 连接管理器。
   * relay 管理器提供点对点数据传输通道，支持可靠和尽力而为两种模式。
   *
   * @returns Relay 管理器实例
   */
  relay(): Relay {
    if (this._relay == null) {
      this._relay = new Relay(this);
    }
    return this._relay;
  }

  /**
   * 使用用户 ID 和密码登录 HTTP API。
   * 密码将自动进行 bcrypt 哈希处理。
   *
   * @param nodeId - 用户所属节点 ID
   * @param userId - 用户 ID
   * @param password - 原始密码字符串
   * @param options - 可选的请求配置
   * @returns 认证令牌（Bearer token）
   */
  async login(nodeId: string, userId: string, password: string, options?: RequestOptions): Promise<string> {
    return this.http.login(nodeId, userId, password, options);
  }

  /**
   * 使用登录名和密码登录 HTTP API。
   * 密码将自动进行 bcrypt 哈希处理。
   *
   * @param loginName - 登录名
   * @param password - 原始密码字符串
   * @param options - 可选的请求配置
   * @returns 认证令牌（Bearer token）
   */
  async loginByLoginName(loginName: string, password: string, options?: RequestOptions): Promise<string> {
    return this.http.loginByLoginName(loginName, password, options);
  }

  /**
   * 使用用户 ID 和预处理的密码输入对象登录 HTTP API。
   *
   * @param nodeId - 用户所属节点 ID
   * @param userId - 用户 ID
   * @param password - 密码输入对象
   * @param options - 可选的请求配置
   * @returns 认证令牌（Bearer token）
   */
  async loginWithPassword(
    nodeId: string,
    userId: string,
    password: PasswordInput,
    options?: RequestOptions
  ): Promise<string> {
    return this.http.loginWithPassword(nodeId, userId, password, options);
  }

  /**
   * 使用登录名和预处理的密码输入对象登录 HTTP API。
   *
   * @param loginName - 登录名
   * @param password - 密码输入对象
   * @param options - 可选的请求配置
   * @returns 认证令牌（Bearer token）
   */
  async loginByLoginNameWithPassword(
    loginName: string,
    password: PasswordInput,
    options?: RequestOptions
  ): Promise<string> {
    return this.http.loginByLoginNameWithPassword(loginName, password, options);
  }

  /**
   * 建立 WebSocket 连接。
   * 在调用此方法之前，客户端不会启动 WebSocket 连接。
   * 连接将在后台自动维护，断线后会自动重连。
   *
   * @param options - 可选的连接配置（支持取消信号和超时）
   * @throws {@link ClosedError} 如果客户端已关闭
   */
  async connect(options?: RequestOptions): Promise<void> {
    if (this.closed) {
      throw new ClosedError();
    }
    if (this.connected && this.socket != null) {
      return;
    }

    const waiter = this.ensureConnectWaiter();
    this.ensureRunLoop();

    const abort = mergeAbortSignals(options);
    try {
      await waitForPromise(waiter.promise, abort.signal);
    } finally {
      abort.cleanup();
    }
  }

  /**
   * 关闭客户端。
   * 关闭 WebSocket 连接并停止所有重连尝试。
   * 关闭后客户端实例不再可用。
   */
  async close(): Promise<void> {
    if (this.closed) {
      await this.awaitRunTask();
      return;
    }

    this.closed = true;
    this.stopReconnect = true;
    this.lifecycleAbort.abort(new ClosedError());
    this.rejectConnectWaiter(new ClosedError());
    this.failAllPending(new ClosedError());

    const socket = this.socket;
    const connectingSocket = this.connectingSocket;
    this.socket = undefined;
    this.connectingSocket = undefined;
    this.currentSessionRef = undefined;
    this.connected = false;

    if (socket != null) {
      await socket.close();
    }
    if (connectingSocket != null && connectingSocket !== socket) {
      await connectingSocket.close();
    }
    await this.awaitRunTask();
  }

  /**
   * 发送心跳 Ping 请求，用于检测连接是否正常。
   *
   * @param options - 可选的请求配置
   * @throws {@link NotConnectedError} 如果未建立连接
   * @throws {@link ClosedError} 如果客户端已关闭
   */
  async ping(options?: RequestOptions): Promise<void> {
    await this.rpc(
      (requestId) => ({
        body: {
          oneofKind: "ping",
          ping: { requestId }
        }
      }),
      options
    );
  }

  /**
   * 发送持久化消息。
   * 消息将被持久化存储，目标用户上线后会收到。
   *
   * @param target - 目标用户引用
   * @param body - 消息体字节数据
   * @param options - 可选的请求配置
   * @returns 发送后的消息对象
   * @throws 如果 target 无效或 body 为空则抛出错误
   */
  async sendMessage(target: UserRef, body: Uint8Array, options?: RequestOptions): Promise<Message> {
    validateUserRef(target, "target");
    if (body.length === 0) {
      throw new Error("body is required");
    }

    const result = await this.rpc(
      (requestId) => ({
        body: {
          oneofKind: "sendMessage",
          sendMessage: {
            requestId,
            target: userRefToProto(target),
            body: new Uint8Array(body),
            deliveryKind: ClientDeliveryKind.PERSISTENT,
            deliveryMode: 0,
            syncMode: ClientMessageSyncMode.UNSPECIFIED
          }
        }
      }),
      options
    );
    if (!isMessage(result)) {
      throw new ProtocolError("missing message in send response");
    }
    return result;
  }

  /**
   * 发送持久化消息（{@link sendMessage} 的别名）。
   *
   * @param target - 目标用户引用
   * @param body - 消息体字节数据
   * @param options - 可选的请求配置
   * @returns 发送后的消息对象
   */
  postMessage(target: UserRef, body: Uint8Array, options?: RequestOptions): Promise<Message> {
    return this.sendMessage(target, body, options);
  }

  /**
   * 发送瞬时数据包（中继消息）。
   * 数据包不会被持久化存储，适合实时消息推送。
   *
   * @param target - 目标用户引用
   * @param body - 数据包体字节数据
   * @param deliveryMode - 投递模式
   * @param options - 可选的发送配置，支持指定目标会话
   * @returns 中继确认对象
   * @throws 如果 target 无效、body 为空或 deliveryMode 无效则抛出错误
   */
  async sendPacket(
    target: UserRef,
    body: Uint8Array,
    deliveryMode: DeliveryMode,
    options?: SendPacketOptions
  ): Promise<RelayAccepted> {
    validateUserRef(target, "target");
    if (body.length === 0) {
      throw new Error("body is required");
    }
    validateDeliveryMode(deliveryMode);
    if (options?.targetSession != null) {
      validateSessionRef(options.targetSession, "options.targetSession");
    }

    const result = await this.rpc(
      (requestId) => {
        const sendMessage = {
          requestId,
          target: userRefToProto(target),
          body: new Uint8Array(body),
          deliveryKind: ClientDeliveryKind.TRANSIENT,
          deliveryMode: deliveryModeToProto(deliveryMode),
          syncMode: ClientMessageSyncMode.UNSPECIFIED
        };
        if (options?.targetSession != null) {
          Object.assign(sendMessage, {
            targetSession: sessionRefToProto(options.targetSession)
          });
        }
        return {
          body: {
            oneofKind: "sendMessage",
            sendMessage
          }
        };
      },
      options
    );
    if (!isRelayAccepted(result)) {
      throw new ProtocolError("missing transient_accepted in send response");
    }
    return result;
  }

  /**
   * 发送瞬时数据包（{@link sendPacket} 的别名）。
   *
   * @param target - 目标用户引用
   * @param body - 数据包体字节数据
   * @param deliveryMode - 投递模式
   * @param options - 可选的发送配置
   * @returns 中继确认对象
   */
  postPacket(
    target: UserRef,
    body: Uint8Array,
    deliveryMode: DeliveryMode,
    options?: SendPacketOptions
  ): Promise<RelayAccepted> {
    return this.sendPacket(target, body, deliveryMode, options);
  }

  /**
   * 创建新用户。
   *
   * @param request - 创建用户请求参数
   * @param options - 可选的请求配置
   * @returns 创建后的用户对象
   * @throws 如果 username 或 role 为空则抛出错误
   */
  async createUser(request: CreateUserRequest, options?: RequestOptions): Promise<User> {
    if (request.username === "") {
      throw new Error("username is required");
    }
    if (request.role === "") {
      throw new Error("role is required");
    }

    const result = await this.rpc(
      (requestId) => ({
        body: {
          oneofKind: "createUser",
          createUser: {
            requestId,
            username: request.username,
            password: request.password == null ? "" : passwordWireValue(request.password),
            profileJson: request.profileJson == null ? new Uint8Array(0) : new Uint8Array(request.profileJson),
            role: request.role,
            loginName: request.loginName ?? ""
          }
        }
      }),
      options
    );
    if (!isUser(result)) {
      throw new ProtocolError("missing user in create_user_response");
    }
    return result;
  }

  /**
   * 创建频道（角色默认为 "channel"）。
   * 是 {@link createUser} 的便捷方法，自动设置 role 为 "channel"。
   *
   * @param request - 创建请求参数（无需提供 role）
   * @param options - 可选的请求配置
   * @returns 创建后的频道用户对象
   */
  createChannel(
    request: Omit<CreateUserRequest, "role"> & Partial<Pick<CreateUserRequest, "role">>,
    options?: RequestOptions
  ): Promise<User> {
    return this.createUser({ ...request, role: request.role ?? "channel" }, options);
  }

  /**
   * 获取用户信息。
   *
   * @param target - 目标用户引用
   * @param options - 可选的请求配置
   * @returns 用户对象
   */
  async getUser(target: UserRef, options?: RequestOptions): Promise<User> {
    validateUserRef(target, "target");

    const result = await this.rpc(
      (requestId) => ({
        body: {
          oneofKind: "getUser",
          getUser: { requestId, user: userRefToProto(target) }
        }
      }),
      options
    );
    if (!isUser(result)) {
      throw new ProtocolError("missing user in get_user_response");
    }
    return result;
  }

  /**
   * 获取当前用户可通讯的活跃用户列表。
   * 支持按名称子串和用户唯一标识过滤。
   * 普通用户看到的结果会受到目标用户或频道 `system.visible_to_others=false`
   * metadata 的影响，但这不会阻止调用方在已知 uid 时继续直接发送消息。
   *
   * @param request - 可选过滤条件
   * @param options - 可选的请求配置
   * @returns 用户列表
   */
  async listUsers(request: ListUsersRequest = {}, options?: RequestOptions): Promise<User[]> {
    validateListUsersRequest(request, "request");
    const name = normalizeListUsersName(request.name);

    const result = await this.rpc(
      (requestId) => {
        const listUsers: {
          requestId: string;
          name: string;
          uid?: { nodeId: string; userId: string };
        } = {
          requestId,
          name
        };
        if (request.uid != null) {
          listUsers.uid = listUsersUidToProto(request.uid);
        }
        return {
          body: {
            oneofKind: "listUsers",
            listUsers
          }
        };
      },
      options
    );
    if (!Array.isArray(result)) {
      throw new ProtocolError("missing items in list_users_response");
    }
    return result;
  }

  /**
   * 更新用户信息。
   * 仅更新请求中提供的字段，未提供的字段保持不变。
   *
   * @param target - 目标用户引用
   * @param request - 更新请求参数（所有字段可选）
   * @param options - 可选的请求配置
   * @returns 更新后的用户对象
   */
  async updateUser(target: UserRef, request: UpdateUserRequest, options?: RequestOptions): Promise<User> {
    validateUserRef(target, "target");

    const result = await this.rpc(
      (requestId) => {
        const updateUser: ProtoUpdateUserRequest = {
          requestId,
          user: userRefToProto(target)
        };
        if (request.username != null) {
          updateUser.username = { value: request.username };
        }
        if (request.password != null) {
          updateUser.password = { value: passwordWireValue(request.password) };
        }
        if (request.profileJson != null) {
          updateUser.profileJson = { value: new Uint8Array(request.profileJson) };
        }
        if (request.role != null) {
          updateUser.role = { value: request.role };
        }
        if (request.loginName != null) {
          updateUser.loginName = { value: request.loginName };
        }
        return {
          body: {
            oneofKind: "updateUser",
            updateUser
          }
        };
      },
      options
    );
    if (!isUser(result)) {
      throw new ProtocolError("missing user in update_user_response");
    }
    return result;
  }

  /**
   * 删除用户。
   *
   * @param target - 目标用户引用
   * @param options - 可选的请求配置
   * @returns 删除操作结果
   */
  async deleteUser(target: UserRef, options?: RequestOptions): Promise<DeleteUserResult> {
    validateUserRef(target, "target");

    const result = await this.rpc(
      (requestId) => ({
        body: {
          oneofKind: "deleteUser",
          deleteUser: { requestId, user: userRefToProto(target) }
        }
      }),
      options
    );
    if (!isDeleteUserResult(result)) {
      throw new ProtocolError("missing status in delete_user_response");
    }
    return result;
  }

  /**
   * 获取用户元数据。
   * WebSocket/protobuf metadata API 保持 raw bytes 语义，不提供 HTTP typed_value 视图。
   *
   * @param owner - 元数据所有者的用户引用
   * @param key - 元数据键名
   * @param options - 可选的请求配置
   * @returns 用户元数据对象
   */
  async getUserMetadata(owner: UserRef, key: string, options?: RequestOptions): Promise<UserMetadata> {
    validateUserRef(owner, "owner");
    validateUserMetadataKey(key);

    const result = await this.rpc(
      (requestId) => ({
        body: {
          oneofKind: "getUserMetadata",
          getUserMetadata: {
            requestId,
            owner: userRefToProto(owner),
            key
          }
        }
      }),
      options
    );
    if (!isUserMetadata(result)) {
      throw new ProtocolError("missing metadata in get_user_metadata_response");
    }
    return result;
  }

  /**
   * 插入或更新用户元数据。
   * 如果键已存在则更新，不存在则创建。
   * WebSocket/protobuf metadata API 始终直接发送 raw bytes；
   * 对于 `system.visible_to_others`，请传入 UTF-8 `true` / `false`。
   *
   * @param owner - 元数据所有者的用户引用
   * @param key - 元数据键名
   * @param request - 更新请求参数
   * @param options - 可选的请求配置
   * @returns 更新后的用户元数据对象
   */
  async upsertUserMetadata(
    owner: UserRef,
    key: string,
    request: UpsertUserMetadataRequest,
    options?: RequestOptions
  ): Promise<UserMetadata> {
    validateUserRef(owner, "owner");
    validateUserMetadataKey(key);
    if (request.value == null) {
      throw new Error("value is required");
    }
    validateUserMetadataValuePolicy(key, request.value, request.expiresAt, "request");

    const result = await this.rpc(
      (requestId) => {
        const upsertUserMetadata: ProtoUpsertUserMetadataRequest = {
          requestId,
          owner: userRefToProto(owner),
          key,
          value: new Uint8Array(request.value)
        };
        if (request.expiresAt != null) {
          upsertUserMetadata.expiresAt = { value: request.expiresAt };
        }
        return {
          body: {
            oneofKind: "upsertUserMetadata",
            upsertUserMetadata
          }
        };
      },
      options
    );
    if (!isUserMetadata(result)) {
      throw new ProtocolError("missing metadata in upsert_user_metadata_response");
    }
    return result;
  }

  /**
   * 删除用户元数据。
   *
   * @param owner - 元数据所有者的用户引用
   * @param key - 元数据键名
   * @param options - 可选的请求配置
   * @returns 被删除的用户元数据对象
   */
  async deleteUserMetadata(owner: UserRef, key: string, options?: RequestOptions): Promise<UserMetadata> {
    validateUserRef(owner, "owner");
    validateUserMetadataKey(key);

    const result = await this.rpc(
      (requestId) => ({
        body: {
          oneofKind: "deleteUserMetadata",
          deleteUserMetadata: {
            requestId,
            owner: userRefToProto(owner),
            key
          }
        }
      }),
      options
    );
    if (!isUserMetadata(result)) {
      throw new ProtocolError("missing metadata in delete_user_metadata_response");
    }
    return result;
  }

  /**
   * 扫描用户元数据。
   * 支持按前缀过滤和分页查询。
   *
   * @param owner - 元数据所有者的用户引用
   * @param request - 扫描请求参数（可选，默认扫描全部）
   * @param options - 可选的请求配置
   * @returns 扫描结果，包含条目列表和下一页游标
   */
  async scanUserMetadata(
    owner: UserRef,
    request: ScanUserMetadataRequest = {},
    options?: RequestOptions
  ): Promise<ScanUserMetadataResult> {
    validateUserRef(owner, "owner");
    validateUserMetadataScanRequest(request);

    const result = await this.rpc(
      (requestId) => ({
        body: {
          oneofKind: "scanUserMetadata",
          scanUserMetadata: {
            requestId,
            owner: userRefToProto(owner),
            prefix: request.prefix ?? "",
            after: request.after ?? "",
            limit: request.limit ?? 0
          }
        }
      }),
      options
    );
    if (!isScanUserMetadataResult(result)) {
      throw new ProtocolError("missing metadata in scan_user_metadata_response");
    }
    return result;
  }

  /**
   * 插入或更新附件关系。
   * 附件用于管理用户之间的关联关系（如频道订阅、管理员、黑名单等）。
   *
   * @param owner - 附件所有者（关系主体）
   * @param subject - 附件目标（关系客体）
   * @param attachmentType - 附件类型
   * @param configJson - 附件配置的 JSON 字节数据（可选，默认空数据）
   * @param options - 可选的请求配置
   * @returns 附件对象
   */
  async upsertAttachment(
    owner: UserRef,
    subject: UserRef,
    attachmentType: AttachmentType,
    configJson = new Uint8Array(),
    options?: RequestOptions
  ): Promise<Attachment> {
    validateUserRef(owner, "owner");
    validateUserRef(subject, "subject");

    const result = await this.rpc(
      (requestId) => ({
        body: {
          oneofKind: "upsertUserAttachment",
          upsertUserAttachment: {
            requestId,
            owner: userRefToProto(owner),
            subject: userRefToProto(subject),
            attachmentType: attachmentTypeToProto(attachmentType),
            configJson: new Uint8Array(configJson)
          }
        }
      }),
      options
    );
    if (!isAttachment(result)) {
      throw new ProtocolError("missing attachment in upsert_user_attachment_response");
    }
    return result;
  }

  /**
   * 删除附件关系。
   *
   * @param owner - 附件所有者
   * @param subject - 附件目标
   * @param attachmentType - 附件类型
   * @param options - 可选的请求配置
   * @returns 被删除的附件对象
   */
  async deleteAttachment(owner: UserRef, subject: UserRef, attachmentType: AttachmentType, options?: RequestOptions): Promise<Attachment> {
    validateUserRef(owner, "owner");
    validateUserRef(subject, "subject");

    const result = await this.rpc(
      (requestId) => ({
        body: {
          oneofKind: "deleteUserAttachment",
          deleteUserAttachment: {
            requestId,
            owner: userRefToProto(owner),
            subject: userRefToProto(subject),
            attachmentType: attachmentTypeToProto(attachmentType)
          }
        }
      }),
      options
    );
    if (!isAttachment(result)) {
      throw new ProtocolError("missing attachment in delete_user_attachment_response");
    }
    return result;
  }

  /**
   * 列出附件关系。可按附件类型过滤。
   *
   * @param owner - 附件所有者
   * @param attachmentType - 可选的附件类型过滤条件
   * @param options - 可选的请求配置
   * @returns 附件对象数组
   */
  async listAttachments(owner: UserRef, attachmentType?: AttachmentType, options?: RequestOptions): Promise<Attachment[]> {
    validateUserRef(owner, "owner");

    const result = await this.rpc(
      (requestId) => ({
        body: {
          oneofKind: "listUserAttachments",
          listUserAttachments: {
            requestId,
            owner: userRefToProto(owner),
            attachmentType: attachmentType == null ? 0 : attachmentTypeToProto(attachmentType)
          }
        }
      }),
      options
    );
    if (!Array.isArray(result)) {
      throw new ProtocolError("missing items in list_user_attachments_response");
    }
    return result;
  }

  /**
   * 订阅频道。
   *
   * @param subscriber - 订阅者用户引用
   * @param channel - 频道用户引用
   * @param options - 可选的请求配置
   * @returns 订阅关系对象
   */
  async subscribeChannel(subscriber: UserRef, channel: UserRef, options?: RequestOptions): Promise<Subscription> {
    const attachment = await this.upsertAttachment(subscriber, channel, "channel_subscription", new Uint8Array(), options);
    return subscriptionFromAttachment(attachment);
  }

  /**
   * 创建频道订阅（{@link subscribeChannel} 的别名）。
   *
   * @param subscriber - 订阅者用户引用
   * @param channel - 频道用户引用
   * @param options - 可选的请求配置
   * @returns 订阅关系对象
   */
  createSubscription(subscriber: UserRef, channel: UserRef, options?: RequestOptions): Promise<Subscription> {
    return this.subscribeChannel(subscriber, channel, options);
  }

  /**
   * 取消频道订阅。
   *
   * @param subscriber - 订阅者用户引用
   * @param channel - 频道用户引用
   * @param options - 可选的请求配置
   * @returns 被取消的订阅关系对象
   */
  async unsubscribeChannel(subscriber: UserRef, channel: UserRef, options?: RequestOptions): Promise<Subscription> {
    const attachment = await this.deleteAttachment(subscriber, channel, "channel_subscription", options);
    return subscriptionFromAttachment(attachment);
  }

  /**
   * 列出用户的所有频道订阅。
   *
   * @param subscriber - 订阅者用户引用
   * @param options - 可选的请求配置
   * @returns 订阅关系对象数组
   */
  async listSubscriptions(subscriber: UserRef, options?: RequestOptions): Promise<Subscription[]> {
    const items = await this.listAttachments(subscriber, "channel_subscription", options);
    return items.map(subscriptionFromAttachment);
  }

  /**
   * 屏蔽（拉黑）用户。
   *
   * @param owner - 执行屏蔽操作的用户引用
   * @param blocked - 被屏蔽的用户引用
   * @param options - 可选的请求配置
   * @returns 黑名单条目对象
   */
  async blockUser(owner: UserRef, blocked: UserRef, options?: RequestOptions): Promise<BlacklistEntry> {
    const attachment = await this.upsertAttachment(owner, blocked, "user_blacklist", new Uint8Array(), options);
    return blacklistEntryFromAttachment(attachment);
  }

  /**
   * 取消屏蔽（解除拉黑）用户。
   *
   * @param owner - 执行解除屏蔽操作的用户引用
   * @param blocked - 被解除屏蔽的用户引用
   * @param options - 可选的请求配置
   * @returns 被删除的黑名单条目对象
   */
  async unblockUser(owner: UserRef, blocked: UserRef, options?: RequestOptions): Promise<BlacklistEntry> {
    const attachment = await this.deleteAttachment(owner, blocked, "user_blacklist", options);
    return blacklistEntryFromAttachment(attachment);
  }

  /**
   * 列出用户的黑名单列表。
   *
   * @param owner - 要查询黑名单的用户引用
   * @param options - 可选的请求配置
   * @returns 黑名单条目对象数组
   */
  async listBlockedUsers(owner: UserRef, options?: RequestOptions): Promise<BlacklistEntry[]> {
    const items = await this.listAttachments(owner, "user_blacklist", options);
    return items.map(blacklistEntryFromAttachment);
  }

  /**
   * 列出用户的消息列表。
   *
   * @param target - 目标用户引用
   * @param limit - 返回的最大消息数量（0 表示不限制）
   * @param options - 可选的请求配置
   * @returns 消息对象数组
   */
  async listMessages(target: UserRef, limit = 0, options?: RequestOptions): Promise<Message[]> {
    validateUserRef(target, "target");
    validateLimit(limit, "limit");

    const result = await this.rpc(
      (requestId) => ({
        body: {
          oneofKind: "listMessages",
          listMessages: {
            requestId,
            user: userRefToProto(target),
            limit
          }
        }
      }),
      options
    );
    if (!Array.isArray(result)) {
      throw new ProtocolError("missing items in list_messages_response");
    }
    return result;
  }

  /**
   * 列出集群事件（事件溯源）。
   *
   * @param after - 从指定序列号之后开始查询，默认 "0"（从头开始）
   * @param limit - 返回的最大事件数量（0 表示不限制）
   * @param options - 可选的请求配置
   * @returns 事件对象数组
   */
  async listEvents(after = "0", limit = 0, options?: RequestOptions): Promise<TurntfEvent[]> {
    toWireInteger(after, "after");
    validateLimit(limit, "limit");

    const result = await this.rpc(
      (requestId) => ({
        body: {
          oneofKind: "listEvents",
          listEvents: {
            requestId,
            after,
            limit
          }
        }
      }),
      options
    );
    if (!Array.isArray(result)) {
      throw new ProtocolError("missing items in list_events_response");
    }
    return result;
  }

  /**
   * 列出集群中的所有节点。
   *
   * @param options - 可选的请求配置
   * @returns 集群节点对象数组
   */
  async listClusterNodes(options?: RequestOptions): Promise<ClusterNode[]> {
    const result = await this.rpc(
      (requestId) => ({
        body: {
          oneofKind: "listClusterNodes",
          listClusterNodes: { requestId }
        }
      }),
      options
    );
    if (!Array.isArray(result)) {
      throw new ProtocolError("missing items in list_cluster_nodes_response");
    }
    return result;
  }

  /**
   * 列出指定节点上当前已登录的用户。
   *
   * @param nodeId - 节点 ID
   * @param options - 可选的请求配置
   * @returns 已登录用户对象数组
   */
  async listNodeLoggedInUsers(nodeId: string, options?: RequestOptions): Promise<LoggedInUser[]> {
    toRequiredWireInteger(nodeId, "nodeId");

    const result = await this.rpc(
      (requestId) => ({
        body: {
          oneofKind: "listNodeLoggedInUsers",
          listNodeLoggedInUsers: { requestId, nodeId }
        }
      }),
      options
    );
    if (!Array.isArray(result)) {
      throw new ProtocolError("missing items in list_node_logged_in_users_response");
    }
    return result;
  }

  /**
   * 解析用户的在线会话信息。
   * 返回用户的在线节点状态和具体的会话信息。
   *
   * @param user - 目标用户引用
   * @param options - 可选的请求配置
   * @returns 用户会话解析结果
   */
  async resolveUserSessions(user: UserRef, options?: RequestOptions): Promise<ResolveUserSessionsResult> {
    validateUserRef(user, "user");

    const result = await this.rpc(
      (requestId) => ({
        body: {
          oneofKind: "resolveUserSessions",
          resolveUserSessions: {
            requestId,
            user: userRefToProto(user)
          }
        }
      }),
      options
    );
    if (!isResolveUserSessionsResult(result)) {
      throw new ProtocolError("missing resolve_user_sessions_response");
    }
    return result;
  }

  /**
   * 获取节点操作状态。
   * 返回包含消息窗口、事件序列、冲突统计和对等节点状态等信息。
   *
   * @param options - 可选的请求配置
   * @returns 节点操作状态对象
   */
  async operationsStatus(options?: RequestOptions): Promise<OperationsStatus> {
    const result = await this.rpc(
      (requestId) => ({
        body: {
          oneofKind: "operationsStatus",
          operationsStatus: { requestId }
        }
      }),
      options
    );
    if (!isOperationsStatus(result)) {
      throw new ProtocolError("missing status in operations_status_response");
    }
    return result;
  }

  /**
   * 获取 Prometheus 格式的监控指标。
   *
   * @param options - 可选的请求配置
   * @returns Prometheus 格式的指标文本
   */
  async metrics(options?: RequestOptions): Promise<string> {
    const result = await this.rpc(
      (requestId) => ({
        body: {
          oneofKind: "metrics",
          metrics: { requestId }
        }
      }),
      options
    );
    if (typeof result !== "string") {
      throw new ProtocolError("missing text in metrics_response");
    }
    return result;
  }

  private ensureRunLoop(): void {
    if (this.runTask != null) {
      return;
    }
    const task = this.run();
    const trackedTask = task.finally(() => {
      if (this.runTask === trackedTask) {
        this.runTask = undefined;
      }
    });
    this.runTask = trackedTask;
  }

  private async awaitRunTask(): Promise<void> {
    if (this.runTask == null) {
      return;
    }
    try {
      await this.runTask;
    } catch {
      return;
    }
  }

  private ensureConnectWaiter(): Deferred<void> {
    if (this.connectWaiter == null) {
      this.connectWaiter = createDeferred<void>();
    }
    return this.connectWaiter;
  }

  private resolveConnectWaiter(): void {
    if (this.connectWaiter == null) {
      return;
    }
    const waiter = this.connectWaiter;
    this.connectWaiter = undefined;
    waiter.resolve();
  }

  private rejectConnectWaiter(error: unknown): void {
    if (this.connectWaiter == null) {
      return;
    }
    const waiter = this.connectWaiter;
    this.connectWaiter = undefined;
    waiter.reject(copyError(error));
  }

  private async run(): Promise<void> {
    let delayMs = this.initialReconnectDelayMs;
    while (!this.closed) {
      const result = await this.connectAndServe();
      if (result.connected) {
        delayMs = this.initialReconnectDelayMs;
      }
      if (this.closed || !this.shouldRetry(result.error)) {
        this.rejectConnectWaiter(result.error);
        this.failAllPending(result.error);
        return;
      }
      await this.safeHandlerCall(this.handler.onError, result.error);
      try {
        await sleep(delayMs, this.lifecycleAbort.signal);
      } catch {
        this.failAllPending(new ClosedError());
        return;
      }
      delayMs = Math.min(delayMs * 2, this.maxReconnectDelayMs);
    }
  }

  private async connectAndServe(): Promise<ServeResult> {
    if (this.closed) {
      return { connected: false, error: new ClosedError() };
    }

    let connected = false;
    let socket: QueuedWebSocket | undefined;
    const pingAbort = new AbortController();

    try {
      const seen = await Promise.resolve(this.cursorStore.loadSeenMessages());
      socket = await this.dial();
      this.connectingSocket = socket;
      await this.writeProto(socket, {
        body: {
          oneofKind: "login",
          login: buildLoginRequest(this.credentials, seen, this.transientOnly)
        }
      });

      const loginInfo = this.expectLogin(await this.readProto(socket));
      if (this.closed) {
        this.connectingSocket = undefined;
        await socket.close();
        return { connected: false, error: new ClosedError() };
      }

      this.stopReconnect = false;
      this.connectingSocket = undefined;
      this.socket = socket;
      this.currentSessionRef = { ...loginInfo.sessionRef };
      this.connected = true;
      connected = true;

      await this.safeHandlerCall(this.handler.onLogin, loginInfo);
      this.resolveConnectWaiter();

      this.pingTask = this.pingLoop(pingAbort.signal);
      const readError = await this.readLoop(socket);
      this.connected = false;
      this.currentSessionRef = undefined;
      if (this.socket === socket) {
        this.socket = undefined;
      }
      this.failAllPending(new DisconnectedError());
      await this.safeHandlerCall(this.handler.onDisconnect, readError);
      await socket.close();
      return { connected, error: readError };
    } catch (error) {
      this.connected = false;
      this.currentSessionRef = undefined;
      if (this.connectingSocket === socket) {
        this.connectingSocket = undefined;
      }
      if (this.socket === socket) {
        this.socket = undefined;
      }
      if (socket != null) {
        await socket.close();
      }
      return { connected, error };
    } finally {
      pingAbort.abort();
      if (this.pingTask != null) {
        try {
          await this.pingTask;
        } catch {
          // ignore ping task cancellation during shutdown
        } finally {
          this.pingTask = undefined;
        }
      }
    }
  }

  private async dial(): Promise<QueuedWebSocket> {
    const WebSocketImpl = globalThis.WebSocket;
    if (typeof WebSocketImpl !== "function") {
      throw new Error("WebSocket is required");
    }

    const ws = new WebSocketImpl(websocketUrl(this.baseUrl, this.realtimeStream));
    ws.binaryType = "arraybuffer";

    try {
      await waitForSocketOpen(ws);
      return new QueuedWebSocket(ws, () => this.closed);
    } catch (error) {
      try {
        ws.close();
      } catch {
        // ignore close failure during dial cleanup
      }
      throw ensureConnectionError("dial", error);
    }
  }

  private expectLogin(env: ProtoServerEnvelope): LoginInfo {
    switch (env.body.oneofKind) {
      case "loginResponse":
        return {
          user: userFromProto(env.body.loginResponse.user),
          protocolVersion: env.body.loginResponse.protocolVersion,
          sessionRef: sessionRefFromProto(env.body.loginResponse.sessionRef)
        };
      case "error":
        this.stopReconnect = env.body.error.code === "unauthorized";
        throw new ServerError(env.body.error.code, env.body.error.message, env.body.error.requestId);
      default:
        throw new ProtocolError("expected login_response or error");
    }
  }

  private async readLoop(socket: QueuedWebSocket): Promise<unknown> {
    while (true) {
      let env: ProtoServerEnvelope;
      try {
        env = await this.readProto(socket);
      } catch (error) {
        return error;
      }
      try {
        await this.handleServerEnvelope(env);
      } catch (error) {
        await this.safeHandlerCall(this.handler.onError, error);
      }
    }
  }

  private async handleServerEnvelope(env: ProtoServerEnvelope): Promise<void> {
    switch (env.body.oneofKind) {
      case "messagePushed": {
        const message = messageFromProto(env.body.messagePushed.message);
        await this.persistAndDispatchMessage(message);
        return;
      }
      case "packetPushed": {
        const packet = packetFromProto(env.body.packetPushed.packet);
        if (this._relay == null || !this._relay.handlePacket(packet)) {
          await this.safeHandlerCall(this.handler.onPacket, packet);
        }
        return;
      }
      case "sendMessageResponse":
        await this.handleSendMessageResponse(env.body.sendMessageResponse);
        return;
      case "pong":
        this.resolvePending(env.body.pong.requestId, undefined);
        return;
      case "createUserResponse":
        this.resolvePending(env.body.createUserResponse.requestId, userFromProto(env.body.createUserResponse.user));
        return;
      case "getUserResponse":
        this.resolvePending(env.body.getUserResponse.requestId, userFromProto(env.body.getUserResponse.user));
        return;
      case "listUsersResponse":
        this.resolvePending(env.body.listUsersResponse.requestId, env.body.listUsersResponse.items.map(userFromProto));
        return;
      case "updateUserResponse":
        this.resolvePending(env.body.updateUserResponse.requestId, userFromProto(env.body.updateUserResponse.user));
        return;
      case "deleteUserResponse":
        this.resolvePending(env.body.deleteUserResponse.requestId, {
          status: env.body.deleteUserResponse.status,
          user: {
            nodeId: env.body.deleteUserResponse.user?.nodeId ?? "0",
            userId: env.body.deleteUserResponse.user?.userId ?? "0"
          }
        } satisfies DeleteUserResult);
        return;
      case "getUserMetadataResponse":
        this.resolvePending(
          env.body.getUserMetadataResponse.requestId,
          userMetadataFromProto(env.body.getUserMetadataResponse.metadata)
        );
        return;
      case "upsertUserMetadataResponse":
        this.resolvePending(
          env.body.upsertUserMetadataResponse.requestId,
          userMetadataFromProto(env.body.upsertUserMetadataResponse.metadata)
        );
        return;
      case "deleteUserMetadataResponse":
        this.resolvePending(
          env.body.deleteUserMetadataResponse.requestId,
          userMetadataFromProto(env.body.deleteUserMetadataResponse.metadata)
        );
        return;
      case "scanUserMetadataResponse":
        this.resolvePending(
          env.body.scanUserMetadataResponse.requestId,
          scanUserMetadataResultFromProto(env.body.scanUserMetadataResponse)
        );
        return;
      case "listMessagesResponse":
        this.resolvePending(env.body.listMessagesResponse.requestId, env.body.listMessagesResponse.items.map(messageFromProto));
        return;
      case "upsertUserAttachmentResponse":
        this.resolvePending(
          env.body.upsertUserAttachmentResponse.requestId,
          attachmentFromProto(env.body.upsertUserAttachmentResponse.attachment)
        );
        return;
      case "deleteUserAttachmentResponse":
        this.resolvePending(
          env.body.deleteUserAttachmentResponse.requestId,
          attachmentFromProto(env.body.deleteUserAttachmentResponse.attachment)
        );
        return;
      case "listUserAttachmentsResponse":
        this.resolvePending(
          env.body.listUserAttachmentsResponse.requestId,
          env.body.listUserAttachmentsResponse.items.map(attachmentFromProto)
        );
        return;
      case "listEventsResponse":
        this.resolvePending(env.body.listEventsResponse.requestId, eventsFromProto(env.body.listEventsResponse.items));
        return;
      case "listClusterNodesResponse":
        this.resolvePending(
          env.body.listClusterNodesResponse.requestId,
          clusterNodesFromProto(env.body.listClusterNodesResponse.items)
        );
        return;
      case "listNodeLoggedInUsersResponse":
        this.resolvePending(
          env.body.listNodeLoggedInUsersResponse.requestId,
          loggedInUsersFromProto(env.body.listNodeLoggedInUsersResponse.items)
        );
        return;
      case "resolveUserSessionsResponse":
        this.resolvePending(
          env.body.resolveUserSessionsResponse.requestId,
          resolveUserSessionsFromProto(env.body.resolveUserSessionsResponse)
        );
        return;
      case "operationsStatusResponse":
        this.resolvePending(
          env.body.operationsStatusResponse.requestId,
          operationsStatusFromProto(env.body.operationsStatusResponse.status)
        );
        return;
      case "metricsResponse":
        this.resolvePending(env.body.metricsResponse.requestId, env.body.metricsResponse.text);
        return;
      case "error": {
        const error = new ServerError(env.body.error.code, env.body.error.message, env.body.error.requestId);
        if (env.body.error.requestId !== "0") {
          this.rejectPending(env.body.error.requestId, error);
          return;
        }
        throw error;
      }
      case "loginResponse":
        throw new ProtocolError("unexpected login_response after authentication");
      default:
        throw new ProtocolError("unsupported server envelope");
    }
  }

  private async handleSendMessageResponse(response: ProtoSendMessageResponse): Promise<void> {
    const requestId = response.requestId;
    switch (response.body.oneofKind) {
      case "message": {
        try {
          const message = messageFromProto(response.body.message);
          await this.persistAndDispatchMessage(message);
          this.resolvePending(requestId, message);
        } catch (error) {
          this.rejectPending(requestId, error);
        }
        return;
      }
      case "transientAccepted":
        this.resolvePending(requestId, relayAcceptedFromProto(response.body.transientAccepted));
        return;
      default:
        this.rejectPending(requestId, new ProtocolError("empty send_message_response"));
    }
  }

  private async persistAndDispatchMessage(message: Message): Promise<void> {
    await Promise.resolve(this.cursorStore.saveMessage(message));
    await Promise.resolve(this.cursorStore.saveCursor(cursorForMessage(message)));
    if (this.ackMessages) {
      try {
        await this.sendEnvelope({
          body: {
            oneofKind: "ackMessage",
            ackMessage: { cursor: cursorToProto(cursorForMessage(message)) }
          }
        });
      } catch (error) {
        if (!(error instanceof ClosedError) && !(error instanceof NotConnectedError)) {
          await this.safeHandlerCall(this.handler.onError, error);
        }
      }
    }
    await this.safeHandlerCall(this.handler.onMessage, message);
  }

  private async pingLoop(signal: AbortSignal): Promise<void> {
    while (!this.closed && this.connected) {
      try {
        await sleep(this.pingIntervalMs, signal);
      } catch {
        return;
      }
      if (this.closed || !this.connected) {
        return;
      }
      try {
        await this.ping({ timeoutMs: this.requestTimeoutMs });
      } catch (error) {
        if (
          !(error instanceof NotConnectedError) &&
          !(error instanceof ClosedError) &&
          !(error instanceof DisconnectedError)
        ) {
          await this.safeHandlerCall(this.handler.onError, error);
        }
      }
    }
  }

  private nextRequestId(): string {
    this.requestId += 1n;
    return this.requestId.toString();
  }

  private async rpc(
    build: (requestId: string) => Parameters<typeof ProtoClientEnvelope.toBinary>[0],
    options?: RequestOptions
  ): Promise<unknown> {
    const requestId = this.nextRequestId();
    const pending = this.registerPending(requestId);
    const abort = mergeAbortSignals(
      options?.signal == null
        ? { timeoutMs: options?.timeoutMs ?? this.requestTimeoutMs }
        : { signal: options.signal, timeoutMs: options.timeoutMs ?? this.requestTimeoutMs }
    );

    try {
      await this.sendEnvelope(build(requestId));
      return await waitForPromise(pending.promise, abort.signal);
    } finally {
      abort.cleanup();
      this.pending.delete(requestId);
    }
  }

  private registerPending(requestId: string): Deferred<unknown> {
    if (this.closed) {
      throw new ClosedError();
    }
    const deferred = createDeferred<unknown>();
    deferred.promise.catch(() => undefined);
    this.pending.set(requestId, deferred);
    return deferred;
  }

  private resolvePending(requestId: string, value: unknown): void {
    const deferred = this.pending.get(requestId);
    if (deferred == null) {
      return;
    }
    deferred.resolve(value);
  }

  private rejectPending(requestId: string, error: unknown): void {
    const deferred = this.pending.get(requestId);
    if (deferred == null) {
      return;
    }
    deferred.reject(copyError(error));
  }

  private failAllPending(error: unknown): void {
    for (const [requestId, deferred] of this.pending) {
      deferred.reject(copyError(error));
      this.pending.delete(requestId);
    }
  }

  private shouldRetry(error: unknown): boolean {
    if (this.closed || this.stopReconnect || !this.reconnectEnabled) {
      return false;
    }
    if (error instanceof ServerError && error.unauthorized()) {
      return false;
    }
    return !(error instanceof ClosedError);
  }

  private async sendEnvelope(env: Parameters<typeof ProtoClientEnvelope.toBinary>[0]): Promise<void> {
    const socket = this.socket;
    if (this.closed) {
      throw new ClosedError();
    }
    if (socket == null || !socket.isOpen()) {
      throw new NotConnectedError();
    }
    await this.writeProto(socket, env);
  }

  private async writeProto(socket: QueuedWebSocket, env: Parameters<typeof ProtoClientEnvelope.toBinary>[0]): Promise<void> {
    const payload = ProtoClientEnvelope.toBinary(ProtoClientEnvelope.create(env));
    const writeTask = this.writeChain.catch(() => undefined).then(() => socket.write(payload));
    this.writeChain = writeTask.then(() => undefined, () => undefined);
    try {
      await writeTask;
    } catch (error) {
      throw ensureConnectionError("write", error);
    }
  }

  private async readProto(socket: QueuedWebSocket): Promise<ProtoServerEnvelope> {
    const frame = await socket.read();
    if (!frame.isBinary) {
      throw new ProtocolError("invalid protobuf frame");
    }
    try {
      return ProtoServerEnvelope.fromBinary(await frameDataToBytes(frame.data));
    } catch {
      throw new ProtocolError("invalid protobuf frame");
    }
  }

  private async safeHandlerCall<T>(callback: (value: T) => void | Promise<void>, value: T): Promise<void>;
  private async safeHandlerCall(callback: () => void | Promise<void>): Promise<void>;
  private async safeHandlerCall(
    callback: ((...args: unknown[]) => void | Promise<void>),
    ...args: unknown[]
  ): Promise<void> {
    try {
      await callback.apply(this.handler, args);
    } catch {
      return;
    }
  }
}

class QueuedWebSocket {
  private readonly frames: Frame[] = [];
  private readonly waiters: Deferred<Frame>[] = [];
  private readonly closePromise: Promise<void>;

  private closedError?: unknown;
  private socketError?: unknown;

  constructor(
    private readonly socket: WebSocket,
    private readonly isClientClosed: () => boolean
  ) {
    const closeDeferred = createDeferred<void>();
    this.closePromise = closeDeferred.promise;

    socket.addEventListener("message", (event) => {
      if (this.closedError != null) {
        return;
      }
      const frame: Frame = {
        data: (event as MessageEvent<unknown>).data,
        isBinary: typeof (event as MessageEvent<unknown>).data !== "string"
      };
      const waiter = this.waiters.shift();
      if (waiter == null) {
        this.frames.push(frame);
      } else {
        waiter.resolve(frame);
      }
    });

    socket.addEventListener("error", (event) => {
      this.socketError = errorFromWebSocketEvent(event);
    });

    socket.addEventListener("close", (event) => {
      const closeEvent = event as CloseEvent;
      const cause = this.socketError ?? new Error(closeEventMessage(closeEvent));
      const error = this.isClientClosed() ? new ClosedError() : new ConnectionError("read", cause);
      this.finish(error);
      closeDeferred.resolve();
    });
  }

  isOpen(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  async read(): Promise<Frame> {
    const frame = this.frames.shift();
    if (frame != null) {
      return frame;
    }
    if (this.closedError != null) {
      throw copyError(this.closedError);
    }
    const deferred = createDeferred<Frame>();
    this.waiters.push(deferred);
    return deferred.promise;
  }

  async write(payload: Uint8Array): Promise<void> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new NotConnectedError();
    }
    this.socket.send(payload);
  }

  async close(): Promise<void> {
    this.finish(new ClosedError());
    if (this.socket.readyState === WebSocket.CLOSED) {
      return;
    }
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
    await Promise.race([this.closePromise, sleep(200)]);
  }

  private finish(error: unknown): void {
    if (this.closedError != null) {
      return;
    }
    this.closedError = error;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(copyError(error));
    }
  }
}

function validateLimit(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
}

function normalizeListUsersName(name: string | undefined): string {
  return name?.trim() ?? "";
}

function listUsersUidToProto(uid: UserRef): { nodeId: string; userId: string } {
  if (isZeroUserRef(uid)) {
    return { nodeId: "0", userId: "0" };
  }
  return userRefToProto(uid);
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return value != null && Number.isFinite(value) && value > 0 ? value : fallback;
}

function websocketUrl(baseUrl: string, realtime: boolean): string {
  const url = new URL(baseUrl);
  switch (url.protocol) {
    case "http:":
      url.protocol = "ws:";
      break;
    case "https:":
      url.protocol = "wss:";
      break;
    case "ws:":
    case "wss:":
      break;
    default:
      throw new Error(`unsupported base URL scheme ${JSON.stringify(url.protocol.replace(/:$/, ""))}`);
  }
  const suffix = realtime ? "/ws/realtime" : "/ws/client";
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = basePath === "" ? suffix : `${basePath}${suffix}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function waitForSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (event: Event) => {
      cleanup();
      reject(errorFromWebSocketEvent(event));
    };
    const onClose = (event: Event) => {
      cleanup();
      reject(new Error(closeEventMessage(event as CloseEvent)));
    };
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onError, { once: true });
    socket.addEventListener("close", onClose, { once: true });
  });
}

async function frameDataToBytes(data: unknown): Promise<Uint8Array> {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  throw new TypeError("unsupported websocket frame payload");
}

function errorFromWebSocketEvent(event: Event): Error {
  const error = (event as Event & { error?: unknown }).error;
  if (error instanceof Error) {
    return error;
  }
  const message = (event as Event & { message?: string }).message;
  if (typeof message === "string" && message !== "") {
    return new Error(message);
  }
  return new Error("websocket connection error");
}

function closeEventMessage(event: CloseEvent): string {
  const detail = closeReasonToString(event.reason);
  return detail === ""
    ? `websocket closed with code ${event.code}`
    : `websocket closed with code ${event.code}: ${detail}`;
}

function closeReasonToString(reason: unknown): string {
  if (typeof reason === "string") {
    return reason;
  }
  if (reason instanceof ArrayBuffer) {
    return new TextDecoder().decode(reason);
  }
  if (ArrayBuffer.isView(reason)) {
    return new TextDecoder().decode(reason);
  }
  return "";
}

function waitForPromise<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

function subscriptionFromAttachment(attachment: Attachment): Subscription {
  return {
    subscriber: attachment.owner,
    channel: attachment.subject,
    subscribedAt: attachment.attachedAt,
    deletedAt: attachment.deletedAt,
    originNodeId: attachment.originNodeId
  };
}

function blacklistEntryFromAttachment(attachment: Attachment): BlacklistEntry {
  return {
    owner: attachment.owner,
    blocked: attachment.subject,
    blockedAt: attachment.attachedAt,
    deletedAt: attachment.deletedAt,
    originNodeId: attachment.originNodeId
  };
}

function copyError(error: unknown): unknown {
  if (error instanceof ClosedError) {
    return new ClosedError();
  }
  if (error instanceof NotConnectedError) {
    return new NotConnectedError();
  }
  if (error instanceof DisconnectedError) {
    return new DisconnectedError();
  }
  if (error instanceof ServerError) {
    return new ServerError(error.code, error.serverMessage, error.requestId);
  }
  if (error instanceof ProtocolError) {
    return new ProtocolError(error.protocolMessage);
  }
  if (error instanceof ConnectionError) {
    return new ConnectionError(error.op, error.cause);
  }
  return error;
}

function isMessage(value: unknown): value is Message {
  return value != null && typeof value === "object" && "seq" in value && "body" in value;
}

function isRelayAccepted(value: unknown): value is RelayAccepted {
  return value != null && typeof value === "object" && "packetId" in value && "recipient" in value;
}

function isUser(value: unknown): value is User {
  return value != null && typeof value === "object" && "userId" in value && "username" in value;
}

function isAttachment(value: unknown): value is Attachment {
  return value != null && typeof value === "object" && "attachmentType" in value && "owner" in value;
}

function isDeleteUserResult(value: unknown): value is DeleteUserResult {
  return value != null && typeof value === "object" && "status" in value && "user" in value;
}

function isUserMetadata(value: unknown): value is UserMetadata {
  return value != null && typeof value === "object" && "owner" in value && "key" in value && "value" in value;
}

function isScanUserMetadataResult(value: unknown): value is ScanUserMetadataResult {
  return value != null && typeof value === "object" && "items" in value && "count" in value && "nextAfter" in value;
}

function isResolveUserSessionsResult(value: unknown): value is ResolveUserSessionsResult {
  return value != null && typeof value === "object" && "user" in value && "sessions" in value;
}

function isOperationsStatus(value: unknown): value is OperationsStatus {
  return value != null && typeof value === "object" && "nodeId" in value && "peers" in value;
}

function usesLoginNameCredentials(
  credentials: Credentials
): credentials is Extract<Credentials, { loginName: string }> {
  return "loginName" in credentials;
}

function buildLoginRequest(
  credentials: Credentials,
  seen: readonly ReturnType<typeof cursorForMessage>[],
  transientOnly: boolean
): ProtoLoginRequest {
  const password = passwordWireValue(credentials.password);
  const seenMessages = seen.map(cursorToProto);

  if (usesLoginNameCredentials(credentials)) {
    validateLoginName(credentials.loginName, "credentials.loginName");
    return {
      loginName: credentials.loginName,
      password,
      seenMessages,
      transientOnly
    };
  }

  return {
    user: userRefToProto({
      nodeId: credentials.nodeId,
      userId: credentials.userId
    }),
    loginName: "",
    password,
    seenMessages,
    transientOnly
  };
}
