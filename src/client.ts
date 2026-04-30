import {
  ClientDeliveryKind,
  ClientEnvelope as ProtoClientEnvelope,
  ClientMessageSyncMode,
  ServerEnvelope as ProtoServerEnvelope,
  type SendMessageResponse as ProtoSendMessageResponse,
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
  sessionRefFromProto,
  sessionRefToProto,
  userFromProto,
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
  LoggedInUser,
  LoginInfo,
  Message,
  OperationsStatus,
  Packet,
  RelayAccepted,
  RequestOptions,
  ResolveUserSessionsResult,
  SendPacketOptions,
  SessionRef,
  Subscription,
  UpdateUserRequest,
  User,
  UserRef
} from "./types";
import { abortReason, createDeferred, ensureConnectionError, mergeAbortSignals, sleep, type Deferred } from "./utils";
import {
  cursorForMessage,
  toRequiredWireInteger,
  toWireInteger,
  validateDeliveryMode,
  validateSessionRef,
  validateUserRef
} from "./validation";

export interface Handler {
  onLogin(info: LoginInfo): void | Promise<void>;
  onMessage(message: Message): void | Promise<void>;
  onPacket(packet: Packet): void | Promise<void>;
  onError(error: unknown): void | Promise<void>;
  onDisconnect(error: unknown): void | Promise<void>;
}

export class NopHandler implements Handler {
  onLogin(_info: LoginInfo): void {}
  onMessage(_message: Message): void {}
  onPacket(_packet: Packet): void {}
  onError(_error: unknown): void {}
  onDisconnect(_error: unknown): void {}
}

export interface ClientOptions {
  baseUrl: string;
  credentials: Credentials;
  cursorStore?: CursorStore;
  handler?: Handler;
  fetch?: typeof fetch;
  reconnect?: boolean;
  initialReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  pingIntervalMs?: number;
  requestTimeoutMs?: number;
  ackMessages?: boolean;
  transientOnly?: boolean;
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

export class Client {
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

  constructor(options: ClientOptions) {
    if (options.baseUrl.trim() === "") {
      throw new Error("baseUrl is required");
    }
    validateUserRef(options.credentials, "credentials");
    validatePassword(options.credentials.password);

    this.http = new HTTPClient(
      options.baseUrl,
      options.fetch == null ? {} : { fetch: options.fetch }
    );
    this.credentials = {
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

  get baseUrl(): string {
    return this.http.baseUrl;
  }

  get sessionRef(): SessionRef | undefined {
    if (this.currentSessionRef == null) {
      return undefined;
    }
    return { ...this.currentSessionRef };
  }

  async login(nodeId: string, userId: string, password: string, options?: RequestOptions): Promise<string> {
    return this.http.login(nodeId, userId, password, options);
  }

  async loginWithPassword(
    nodeId: string,
    userId: string,
    password: PasswordInput,
    options?: RequestOptions
  ): Promise<string> {
    return this.http.loginWithPassword(nodeId, userId, password, options);
  }

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

  postMessage(target: UserRef, body: Uint8Array, options?: RequestOptions): Promise<Message> {
    return this.sendMessage(target, body, options);
  }

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

  postPacket(
    target: UserRef,
    body: Uint8Array,
    deliveryMode: DeliveryMode,
    options?: SendPacketOptions
  ): Promise<RelayAccepted> {
    return this.sendPacket(target, body, deliveryMode, options);
  }

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
            role: request.role
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

  createChannel(
    request: Omit<CreateUserRequest, "role"> & Partial<Pick<CreateUserRequest, "role">>,
    options?: RequestOptions
  ): Promise<User> {
    return this.createUser({ ...request, role: request.role ?? "channel" }, options);
  }

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

  async subscribeChannel(subscriber: UserRef, channel: UserRef, options?: RequestOptions): Promise<Subscription> {
    const attachment = await this.upsertAttachment(subscriber, channel, "channel_subscription", new Uint8Array(), options);
    return subscriptionFromAttachment(attachment);
  }

  createSubscription(subscriber: UserRef, channel: UserRef, options?: RequestOptions): Promise<Subscription> {
    return this.subscribeChannel(subscriber, channel, options);
  }

  async unsubscribeChannel(subscriber: UserRef, channel: UserRef, options?: RequestOptions): Promise<Subscription> {
    const attachment = await this.deleteAttachment(subscriber, channel, "channel_subscription", options);
    return subscriptionFromAttachment(attachment);
  }

  async listSubscriptions(subscriber: UserRef, options?: RequestOptions): Promise<Subscription[]> {
    const items = await this.listAttachments(subscriber, "channel_subscription", options);
    return items.map(subscriptionFromAttachment);
  }

  async blockUser(owner: UserRef, blocked: UserRef, options?: RequestOptions): Promise<BlacklistEntry> {
    const attachment = await this.upsertAttachment(owner, blocked, "user_blacklist", new Uint8Array(), options);
    return blacklistEntryFromAttachment(attachment);
  }

  async unblockUser(owner: UserRef, blocked: UserRef, options?: RequestOptions): Promise<BlacklistEntry> {
    const attachment = await this.deleteAttachment(owner, blocked, "user_blacklist", options);
    return blacklistEntryFromAttachment(attachment);
  }

  async listBlockedUsers(owner: UserRef, options?: RequestOptions): Promise<BlacklistEntry[]> {
    const items = await this.listAttachments(owner, "user_blacklist", options);
    return items.map(blacklistEntryFromAttachment);
  }

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
          login: {
            user: userRefToProto({
              nodeId: this.credentials.nodeId,
              userId: this.credentials.userId
            }),
            password: passwordWireValue(this.credentials.password),
            seenMessages: seen.map(cursorToProto),
            transientOnly: this.transientOnly
          }
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
      case "packetPushed":
        await this.safeHandlerCall(this.handler.onPacket, packetFromProto(env.body.packetPushed.packet));
        return;
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

function isResolveUserSessionsResult(value: unknown): value is ResolveUserSessionsResult {
  return value != null && typeof value === "object" && "user" in value && "sessions" in value;
}

function isOperationsStatus(value: unknown): value is OperationsStatus {
  return value != null && typeof value === "object" && "nodeId" in value && "peers" in value;
}
