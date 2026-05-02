/**
 * Relay 点对点传输层。
 *
 * 基于 Packet（瞬时消息）构建可靠的（或尽力而为的）点对点数据传输通道。
 * 支持三种可靠性模式（BestEffort、AtLeastOnce、ReliableOrdered），
 * 滑动窗口流量控制，ACK / 重传机制，以及完整的连接生命周期管理。
 *
 * 使用方式：
 * ```ts
 * // 获取或创建 Relay 管理器
 * const relay = client.relay();
 *
 * // 注册入站连接处理器
 * relay.onConnection((conn) => {
 *   console.log("收到入站 relay 连接:", conn.relayId);
 *   for await (const data of conn) {
 *     console.log("收到数据:", data);
 *   }
 * });
 *
 * // 发起出站连接
 * const conn = await relay.connect({ nodeId: "1", userId: "2" });
 * await conn.send(new TextEncoder().encode("你好"));
 *
 * // 使用 async 迭代器接收数据
 * for await (const data of conn) {
 *   console.log("收到:", data);
 * }
 * ```
 *
 * @module
 */

import { RelayEnvelope as ProtoRelayEnvelopeMsg, RelayKind as ProtoRelayKind } from "./generated/relay";
import type { RelayEnvelope as ProtoRelayEnvelope } from "./generated/relay";
import type { Client } from "./client";
import { createDeferred } from "./utils";
import type { Deferred } from "./utils";
import {
  Reliability,
  RelayState,
  RelayError,
  RelayErrorCodes,
  type DeliveryMode,
  type Packet,
  type RelayConfig,
  type SessionRef,
  type UserRef
} from "./types";

// ---------------------------------------------------------------------------
// 内部帮助函数
// ---------------------------------------------------------------------------

/**
 * 生成 128 位随机 relay ID（十六进制字符串）。
 */
function newRelayId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 将可选的 RelayConfig 解析为完整配置（填充默认值）。
 */
function resolveConfig(config?: RelayConfig): Required<RelayConfig> {
  return {
    reliability: config?.reliability ?? 2, // ReliableOrdered
    windowSize: config?.windowSize ?? 16,
    openTimeoutMs: config?.openTimeoutMs ?? 10000,
    closeTimeoutMs: config?.closeTimeoutMs ?? 5000,
    ackTimeoutMs: config?.ackTimeoutMs ?? 3000,
    maxRetransmits: config?.maxRetransmits ?? 5,
    idleTimeoutMs: config?.idleTimeoutMs ?? 0,
    sendBufferSize: config?.sendBufferSize ?? 65536,
    deliveryMode: (config?.deliveryMode ?? "route_retry") as DeliveryMode,
    sendTimeoutMs: config?.sendTimeoutMs ?? 0,
    receiveTimeoutMs: config?.receiveTimeoutMs ?? 0
  };
}

// ---------------------------------------------------------------------------
// 未确认帧
// ---------------------------------------------------------------------------

interface UnackedFrame {
  /** 原始数据 */
  data: Uint8Array;
  /** 已重传次数 */
  retransmit: number;
}

// ---------------------------------------------------------------------------
// RelayConnection
// ---------------------------------------------------------------------------

/**
 * Relay 点对点连接。
 *
 * 表示一条通过 relay 协议建立的逻辑连接，支持异步数据发送和接收。
 * 接收数据可通过 {@link onData} 回调注册或通过 `for await...of` 异步迭代器消费。
 *
 * @example
 * ```ts
 * // 发送
 * await conn.send(new Uint8Array([1, 2, 3]));
 *
 * // 迭代接收
 * for await (const data of conn) {
 *   console.log(data);
 * }
 * ```
 */
export class RelayConnection {
  /** 连接唯一标识 */
  readonly relayId: string;

  /** 初始化状态（仅在构造函数中设置，后续通过 handleClose 变更） */
  private _state: number;
  private config: Required<RelayConfig>;

  // -- 对端信息 ----------------------------------------------------------
  private remotePeer: UserRef;
  private remoteSession: SessionRef;
  private mySession: SessionRef;

  // -- 滑动窗口 ----------------------------------------------------------
  private sendBase = 0;
  private nextSeq = 0;
  private unacked = new Map<number, UnackedFrame>();
  private expectedSeq = 0;
  private recvBuf = new Map<number, Uint8Array>();
  private retransCnt = 0;

  // -- 发送队列（仅可靠模式） ----------------------------------------------
  private sendQueue: Uint8Array[] = [];

  // -- 接收缓冲 + 等待队列 ------------------------------------------------
  private recvBuffer: Uint8Array[] = [];
  private recvWaiters: Array<Deferred<Uint8Array | null>> = [];

  // -- 定时器 ------------------------------------------------------------
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  // -- 生命周期 ----------------------------------------------------------
  private openDeferred = createDeferred<void>();
  private closeError: Error | undefined = undefined;

  // -- 回调容器 ----------------------------------------------------------
  private onDataHandlers: Array<(data: Uint8Array) => void> = [];
  private onCloseHandlers: Array<(error?: Error) => void> = [];

  // -- 管理器引用 --------------------------------------------------------
  private relay: Relay;
  private client: Client;

  constructor(
    relay: Relay,
    client: Client,
    relayId: string,
    remotePeer: UserRef,
    remoteSession: SessionRef,
    mySession: SessionRef,
    config: Required<RelayConfig>,
    initialState: number,
  ) {
    this.relay = relay;
    this.client = client;
    this.relayId = relayId;
    this.remotePeer = remotePeer;
    this.remoteSession = remoteSession;
    this.mySession = mySession;
    this.config = config;
    this._state = initialState;

    if (initialState === RelayState.Open) {
      this.openDeferred.resolve();
    }

    this.resetIdleTimer();
  }

  /** 当前连接状态。 */
  get state(): number {
    return this._state;
  }

  // ======================================================================
  // 公共 API
  // ======================================================================

  /**
   * 发送数据。
   *
   * - BestEffort 模式：直接将数据编码为 DATA 帧并发送。返回的 Promise 在网络写出完成后 resolve。
   * - AtLeastOnce / ReliableOrdered：将数据加入发送队列后立即返回，
   *   实际发送由后台逻辑处理（包括序列号分配、滑动窗口、ACK 等待和重传）。
   *
   * @param data - 要发送的字节数据
   * @throws {RelayError} 如果连接未处于 Open 状态
   */
  async send(data: Uint8Array): Promise<void> {
    if (data.length === 0) {
      return;
    }

    if (this._state !== RelayState.Open) {
      throw new RelayError(RelayErrorCodes.NotConnected, "connection not open");
    }

    this.resetIdleTimer();

    if (this.config.reliability === Reliability.BestEffort) {
      const sendPromise = this.sendRelayEnvelope({
        relayId: this.relayId,
        kind: ProtoRelayKind.DATA,
        senderSession: this.mySession,
        targetSession: this.remoteSession,
        seq: "0",
        ackSeq: "0",
        payload: new Uint8Array(data),
        sentAtMs: String(Date.now()),
      });

      if (this.config.sendTimeoutMs > 0) {
        await this.withTimeout(sendPromise, this.config.sendTimeoutMs);
      } else {
        await sendPromise;
      }
      return;
    }

    // 可靠模式：加入发送队列
    this.sendQueue.push(new Uint8Array(data));
    this.tryFlushSendQueue();
  }

  /**
   * 注册数据接收回调。
   * 每次收到对端发来的数据时调用 handler。
   * 注册的回调不影响 async 迭代器消费。
   *
   * @param handler - 接收到数据时的回调函数
   */
  onData(handler: (data: Uint8Array) => void): void {
    this.onDataHandlers.push(handler);
  }

  /**
   * 注册连接关闭回调。
   * 连接关闭（无论是本地关闭、远端关闭还是错误导致）时调用 handler。
   *
   * @param handler - 关闭回调，参数为关闭原因（正常关闭时为 undefined）
   */
  onClose(handler: (error?: Error) => void): void {
    this.onCloseHandlers.push(handler);
  }

  /**
   * 单次接收数据。
   * 返回 Promise，在有数据可用时 resolve 为数据，连接关闭时 resolve 为 null。
   */
  async receive(): Promise<Uint8Array | null> {
    if (this.recvBuffer.length > 0) {
      return this.recvBuffer.shift()!;
    }
    if (this._state === RelayState.Closed) {
      return null;
    }

    const deferred = createDeferred<Uint8Array | null>();
    this.recvWaiters.push(deferred);
    return deferred.promise;
  }

  /**
   * 超时接收数据。
   *
   * 在指定时间内等待数据到达，超时则抛出 RelayError。当 timeoutMs 为 0 或未指定时使用配置中的 receiveTimeoutMs；
   * 若配置值也为 0 则退化到普通 receive（无限等待）。
   *
   * @param timeoutMs - 超时毫秒数，覆盖配置中的 receiveTimeoutMs
   * @returns 接收到的数据，连接关闭时返回 null
   * @throws {RelayError} 接收超时时抛出 code 为 ReceiveTimeout 的错误
   */
  async receiveTimeout(timeoutMs?: number): Promise<Uint8Array | null> {
    const timeout = timeoutMs ?? this.config.receiveTimeoutMs;

    if (this.recvBuffer.length > 0) {
      return this.recvBuffer.shift()!;
    }
    if (this._state === RelayState.Closed) {
      return null;
    }

    // 不超时，退化到普通 receive
    if (timeout <= 0) {
      return this.receive();
    }

    return new Promise<Uint8Array | null>((resolve, reject) => {
      const deferred = createDeferred<Uint8Array | null>();
      this.recvWaiters.push(deferred);

      const timer = setTimeout(() => {
        const idx = this.recvWaiters.indexOf(deferred);
        if (idx >= 0) {
          this.recvWaiters.splice(idx, 1);
        }
        reject(new RelayError(RelayErrorCodes.ReceiveTimeout, "receive timeout"));
      }, timeout);

      deferred.promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /**
   * 异步迭代器。
   * 用于 `for await...of` 循环消费接收到的数据。
   * 连接正常关闭时迭代自然结束；连接因错误关闭时迭代抛出异常。
   */
  async *[Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
    while (true) {
      const data = await this.receive();
      if (data == null) {
        break;
      }
      yield data;
    }
  }

  /**
   * 优雅关闭连接。
   * 发送 CLOSE 帧后清理本地状态。
   */
  async close(): Promise<void> {
    if (this._state !== RelayState.Open) {
      return;
    }
    this._state = RelayState.Closing;

    await this.sendRelayEnvelope({
      relayId: this.relayId,
      kind: ProtoRelayKind.CLOSE,
      senderSession: this.mySession,
      targetSession: this.remoteSession,
      seq: "0",
      ackSeq: "0",
      payload: new Uint8Array(0),
      sentAtMs: String(Date.now()),
    }).catch(() => { /* 忽略关闭时的发送错误 */ });

    this.handleClose(undefined);
  }

  /**
   * 强制关闭连接，不发送 CLOSE 帧。
   *
   * @param reason - 关闭原因
   */
  abort(reason?: Error): void {
    this.handleClose(reason);
  }

  // ======================================================================
  // 内部方法（供 Relay 管理器调用）
  // ======================================================================

  /**
   * 尝试解码 body 并分发给对应连接的处理方法。
   * 由 Relay.handlePacket 在接收到 DATA / ACK / PING 帧时调用。
   */
  handleEnvelope(env: ProtoRelayEnvelope): void {
    this.resetIdleTimer();

    switch (env.kind) {
      case ProtoRelayKind.DATA:
        this.handleData(env);
        break;
      case ProtoRelayKind.ACK:
        this.handleAck(env);
        break;
      case ProtoRelayKind.PING:
        // 不支持 PING，回复 ERROR
        this.sendRelayEnvelope({
          relayId: this.relayId,
          kind: ProtoRelayKind.ERROR,
          senderSession: this.mySession,
          targetSession: this.remoteSession,
          seq: "0",
          ackSeq: "0",
          payload: new Uint8Array(0),
          sentAtMs: String(Date.now()),
        }).catch(() => {});
        break;
    }
  }

  /**
   * 处理 OPEN_ACK 帧。
   * 由 Relay.handlePacket 在接收到 OPEN_ACK 时调用。
   */
  handleOpenAck(env: ProtoRelayEnvelope): void {
    if (this._state === RelayState.Opening) {
      this._state = RelayState.Open;
      if (env.senderSession != null) {
        this.remoteSession = {
          servingNodeId: env.senderSession.servingNodeId,
          sessionId: env.senderSession.sessionId,
        };
      }
      this.openDeferred.resolve();
    }
  }

  /**
   * 等待 OPEN_ACK（带超时）。
   * 由 Relay.connect 在发送 OPEN 帧后调用。
   */
  async waitForOpen(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new RelayError(RelayErrorCodes.OpenTimeout, "OPEN timeout waiting for OPEN_ACK"));
      }, timeoutMs);

      this.openDeferred.promise.then(
        () => {
          clearTimeout(timeout);
          resolve();
        },
        (error: unknown) => {
          clearTimeout(timeout);
          reject(error);
        },
      );
    });
  }

  // ======================================================================
  // 私有方法
  // ======================================================================

  /**
   * 将 RelayEnvelope 编码为 protobuf 并通过 client.sendPacket 发送。
   * @internal Relay 管理器同文件访问。
   */
  async sendRelayEnvelope(env: {
    relayId: string;
    kind: ProtoRelayKind;
    senderSession?: SessionRef;
    targetSession?: SessionRef;
    seq: string;
    ackSeq: string;
    payload: Uint8Array;
    sentAtMs: string;
  }): Promise<void> {
    const protoEnv = ProtoRelayEnvelopeMsg.create();
    protoEnv.relayId = env.relayId;
    protoEnv.kind = env.kind;
    if (env.senderSession != null) {
      protoEnv.senderSession = {
        servingNodeId: env.senderSession.servingNodeId,
        sessionId: env.senderSession.sessionId,
      };
    }
    if (env.targetSession != null) {
      protoEnv.targetSession = {
        servingNodeId: env.targetSession.servingNodeId,
        sessionId: env.targetSession.sessionId,
      };
    }
    protoEnv.seq = env.seq;
    protoEnv.ackSeq = env.ackSeq;
    protoEnv.payload = env.payload;
    protoEnv.sentAtMs = env.sentAtMs;

    const body = ProtoRelayEnvelopeMsg.toBinary(protoEnv);
    const mode = this.config.deliveryMode;

    await this.client.sendPacket(
      this.remotePeer,
      body,
      mode,
      { targetSession: this.remoteSession },
    );
  }

  /**
   * 为异步操作添加超时控制。
   *
   * 在指定毫秒数内如果 promise 未 settle，则抛出 RelayError（SendTimeout）。
   * promise 先 settle 则清除定时器。
   *
   * @param promise - 原始异步操作
   * @param timeoutMs - 超时毫秒数
   * @returns 原始 promise 的结果
   */
  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new RelayError(RelayErrorCodes.SendTimeout, "send timeout"));
      }, timeoutMs);

      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /**
   * 尝试将发送队列中的数据发送出去（受滑动窗口限制）。
   * 仅在可靠模式下有意义。
   */
  private tryFlushSendQueue(): void {
    if (this._state !== RelayState.Open) {
      return;
    }

    while (
      this.sendQueue.length > 0 &&
      this.nextSeq - this.sendBase < this.config.windowSize
    ) {
      const data = this.sendQueue.shift()!;
      const seq = this.nextSeq++;
      this.unacked.set(seq, { data: new Uint8Array(data), retransmit: 0 });
      if (this.sendBase === 0) {
        this.sendBase = seq;
      }
      this.scheduleAckTimer();
      this.resetIdleTimer();

      this.sendRelayEnvelope({
        relayId: this.relayId,
        kind: ProtoRelayKind.DATA,
        senderSession: this.mySession,
        targetSession: this.remoteSession,
        seq: String(seq),
        ackSeq: "0",
        payload: new Uint8Array(data),
        sentAtMs: String(Date.now()),
      }).catch((error: unknown) => {
        this.handleClose(error instanceof Error ? error : new RelayError(RelayErrorCodes.Protocol, String(error)));
      });
    }
  }

  /**
   * 将数据推入接收队列，通知等待者和 onData 回调。
   */
  private pushRecvData(data: Uint8Array): void {
    const waiter = this.recvWaiters.shift();
    if (waiter != null) {
      waiter.resolve(data);
    } else {
      this.recvBuffer.push(data);
    }

    for (const handler of this.onDataHandlers) {
      try {
        handler(data);
      } catch {
        // 忽略回调中的异常
      }
    }
  }

  // -- DATA 帧处理 -------------------------------------------------------

  private handleData(env: ProtoRelayEnvelope): void {
    const data = env.payload;

    switch (this.config.reliability) {
      case Reliability.BestEffort: {
        this.pushRecvData(data);
        break;
      }

      case Reliability.AtLeastOnce: {
        // 先回 ACK 再投递
        this.sendRelayEnvelope({
          relayId: this.relayId,
          kind: ProtoRelayKind.ACK,
          senderSession: this.mySession,
          targetSession: this.remoteSession,
          seq: "0",
          ackSeq: env.seq,
          payload: new Uint8Array(0),
          sentAtMs: String(Date.now()),
        }).catch(() => {});
        this.pushRecvData(data);
        break;
      }

      case Reliability.ReliableOrdered: {
        const seq = Number(env.seq);
        if (seq === this.expectedSeq) {
          this.pushRecvData(data);
          this.expectedSeq++;
          // 投递缓冲中后续的连续数据
          while (this.recvBuf.has(this.expectedSeq)) {
            this.pushRecvData(this.recvBuf.get(this.expectedSeq)!);
            this.recvBuf.delete(this.expectedSeq);
            this.expectedSeq++;
          }
        } else if (
          seq > this.expectedSeq &&
          seq - this.expectedSeq < this.config.windowSize
        ) {
          this.recvBuf.set(seq, data);
        }

        // 回复 ACK
        this.sendRelayEnvelope({
          relayId: this.relayId,
          kind: ProtoRelayKind.ACK,
          senderSession: this.mySession,
          targetSession: this.remoteSession,
          seq: "0",
          ackSeq: env.seq,
          payload: new Uint8Array(0),
          sentAtMs: String(Date.now()),
        }).catch(() => {});
        break;
      }
    }
  }

  // -- ACK 帧处理 --------------------------------------------------------

  private handleAck(env: ProtoRelayEnvelope): void {
    if (this.config.reliability === Reliability.BestEffort) {
      return;
    }

    const ackSeq = Number(env.ackSeq);
    if (ackSeq >= this.sendBase) {
      for (let seq = this.sendBase; seq <= ackSeq; seq++) {
        this.unacked.delete(seq);
      }
      this.sendBase = ackSeq + 1;
      this.retransCnt = 0;

      this.scheduleAckTimer();
      this.tryFlushSendQueue();
    }
  }

  // -- ACK 超时与重传 -----------------------------------------------------

  private scheduleAckTimer(): void {
    if (this.ackTimer != null) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
    if (this.unacked.size === 0) {
      return;
    }
    if (this.config.reliability === Reliability.BestEffort) {
      return;
    }

    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      this.onAckTimeout();
    }, this.config.ackTimeoutMs);
  }

  private onAckTimeout(): void {
    if (this._state !== RelayState.Open) {
      return;
    }

    this.retransCnt++;
    if (this.retransCnt > this.config.maxRetransmits) {
      this.handleClose(new RelayError(RelayErrorCodes.MaxRetransmit, "max retransmits exceeded"));
      return;
    }

    // 重传所有未确认帧
    for (const [seq, frame] of this.unacked) {
      this.sendRelayEnvelope({
        relayId: this.relayId,
        kind: ProtoRelayKind.DATA,
        senderSession: this.mySession,
        targetSession: this.remoteSession,
        seq: String(seq),
        ackSeq: "0",
        payload: frame.data,
        sentAtMs: String(Date.now()),
      }).catch((error: unknown) => {
        this.handleClose(error instanceof Error ? error : new RelayError(RelayErrorCodes.Protocol, String(error)));
      });
    }

    this.scheduleAckTimer();
    this.tryFlushSendQueue();
  }

  // -- 空闲超时 ---------------------------------------------------------

  private resetIdleTimer(): void {
    if (this.idleTimer != null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.config.idleTimeoutMs > 0) {
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        this.handleClose(new RelayError(RelayErrorCodes.IdleTimeout, "idle timeout"));
      }, this.config.idleTimeoutMs);
    }
  }

  // -- 连接关闭与清理 -----------------------------------------------------

  /**
   * 内部关闭处理。清除定时器、通知等待者和回调、从管理器中移除。
   */
  handleClose(reason?: Error): void {
    if (this._state === RelayState.Closed) {
      return;
    }
    this._state = RelayState.Closed;
    this.closeError = reason;

    // 清除定时器
    if (this.ackTimer != null) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
    if (this.idleTimer != null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    // 以 null 结束所有接收等待者（流结束信号）
    for (const waiter of this.recvWaiters) {
      waiter.resolve(null);
    }
    this.recvWaiters.length = 0;

    // 清空接收缓冲区
    this.recvBuffer.length = 0;

    // 通知关闭回调
    const handlers = this.onCloseHandlers;
    this.onCloseHandlers = [];
    for (const handler of handlers) {
      try {
        handler(reason);
      } catch {
        // 忽略回调中的异常
      }
    }

    // 从管理器中移除
    this.relay.removeConnection(this.relayId);
  }
}

// ---------------------------------------------------------------------------
// Relay（连接管理器）
// ---------------------------------------------------------------------------

/**
 * Relay 连接管理器。
 *
 * 管理基于 Client 的 relay 连接生命周期，负责入站连接的分发和出站连接的创建。
 * 通过 client.relay() 获取实例。
 *
 * @example
 * ```ts
 * const relay = client.relay();
 * relay.onConnection((conn) => { /* 处理入站连接 *\/ });
 *
 * const conn = await relay.connect({ nodeId: "1", userId: "2" });
 * await conn.send(new TextEncoder().encode("hello"));
 * ```
 */
export class Relay {
  private client: Client;
  private conns = new Map<string, RelayConnection>();
  private onConn?: (conn: RelayConnection) => void;

  constructor(client: Client) {
    this.client = client;
  }

  /**
   * 注册入站 relay 连接的处理器。
   * 每个新入站连接会调用 handler。
   *
   * @param handler - 入站连接处理器
   */
  onConnection(handler: (conn: RelayConnection) => void): void {
    this.onConn = handler;
  }

  /**
   * 向目标用户发起 relay 连接。
   *
   * 自动解析目标用户的在线会话并选择支持瞬时消息的会话。
   * 连接建立后需要通过返回的 {@link RelayConnection} 收发数据。
   *
   * @param target - 目标用户引用
   * @param config - 可选的自定义连接配置
   * @returns 已建立的 RelayConnection
   * @throws {RelayError} 如果目标用户不在线或 OPEN 超时
   */
  async connect(target: UserRef, config?: RelayConfig): Promise<RelayConnection> {
    // 1. 解析目标用户的在线会话
    const sessions = await this.client.resolveUserSessions(target);

    // 2. 选择支持瞬时消息的会话
    let targetSession: SessionRef | undefined;
    for (const s of sessions.sessions) {
      if (s.transientCapable) {
        targetSession = s.session;
        break;
      }
    }
    if (targetSession == null) {
      throw new RelayError(RelayErrorCodes.NotConnected, "no transient-capable session found for target user");
    }

    // 3. 获取本地会话
    const mySession = this.client.sessionRef;
    if (mySession == null) {
      throw new RelayError(RelayErrorCodes.NotConnected, "client not connected");
    }

    // 4. 创建连接（Opening 状态）
    const relayId = newRelayId();
    const cfg = resolveConfig(config);

    const conn = new RelayConnection(
      this,
      this.client,
      relayId,
      target,
      targetSession,
      mySession,
      cfg,
      RelayState.Opening,
    );

    this.conns.set(relayId, conn);

    // 5. 发送 OPEN 帧
    const openEnv = {
      relayId,
      kind: ProtoRelayKind.OPEN,
      senderSession: mySession,
      targetSession,
      seq: "0",
      ackSeq: "0",
      payload: new Uint8Array(0),
      sentAtMs: String(Date.now()),
    };

    try {
      await conn.sendRelayEnvelope(openEnv);
    } catch (error) {
      this.conns.delete(relayId);
      throw error;
    }

    // 6. 等待 OPEN_ACK
    try {
      await conn.waitForOpen(cfg.openTimeoutMs);
    } catch (error) {
      this.conns.delete(relayId);
      conn.handleClose(error instanceof Error ? error : new RelayError(RelayErrorCodes.OpenTimeout, String(error)));
      throw error;
    }

    return conn;
  }

  /**
   * 尝试将 Packet 作为 relay 帧处理。
   *
   * 解码 Packet.body 为 RelayEnvelope，如果成功则分发给对应的连接。
   *
   * @param packet - 待处理的数据包
   * @returns true 表示该包已被 relay 层消费，false 表示不是 relay 帧
   */
  handlePacket(packet: Packet): boolean {
    let env: ProtoRelayEnvelope;
    try {
      env = ProtoRelayEnvelopeMsg.fromBinary(packet.body);
    } catch {
      return false;
    }

    switch (env.kind) {
      // -- 控制帧 --------------------------------------------------------

      case ProtoRelayKind.OPEN: {
        const existing = this.conns.get(env.relayId);
        if (existing == null) {
          this.acceptIncoming(env);
        }
        return true;
      }

      case ProtoRelayKind.OPEN_ACK: {
        const conn = this.conns.get(env.relayId);
        if (conn != null) {
          conn.handleOpenAck(env);
        }
        return true;
      }

      case ProtoRelayKind.CLOSE: {
        const conn = this.conns.get(env.relayId);
        if (conn != null) {
          conn.handleClose(new RelayError(RelayErrorCodes.RemoteClose, "remote peer closed connection"));
        }
        return true;
      }

      case ProtoRelayKind.ERROR: {
        const conn = this.conns.get(env.relayId);
        if (conn != null) {
          const errMsg = new TextDecoder().decode(env.payload);
          conn.handleClose(new RelayError(RelayErrorCodes.Protocol, "remote peer error: " + errMsg));
        }
        return true;
      }

      // -- 数据帧 --------------------------------------------------------

      default: {
        const conn = this.conns.get(env.relayId);
        if (conn != null) {
          conn.handleEnvelope(env);
        }
        return true;
      }
    }
  }

  /**
   * 处理入站 OPEN 帧，创建新的 RelayConnection 并通知用户处理器。
   */
  private acceptIncoming(env: ProtoRelayEnvelope): void {
    const cfg = resolveConfig();

    const mySession = this.client.sessionRef;
    if (mySession == null) {
      return; // 未连接，忽略
    }

    // 从 OPEN 帧中获取对端会话信息
    const remoteSession: SessionRef = env.senderSession ?? {
      servingNodeId: "0",
      sessionId: "",
    };
    // 远端 user ref 需从其他途径获取；此处留空，不影响数据传输
    const remotePeer: UserRef = { nodeId: "0", userId: "0" };

    const conn = new RelayConnection(
      this,
      this.client,
      env.relayId,
      remotePeer,
      remoteSession,
      mySession,
      cfg,
      RelayState.Open,
    );

    // 处理并发 OPEN：relay_id 字典序小的保留
    const existing = this.conns.get(env.relayId);
    if (existing != null) {
      if (env.relayId < existing.relayId) {
        // 新的 relay_id 更小：保留新的，断开已有的
        existing.abort(new RelayError(RelayErrorCodes.DuplicateOpen, "concurrent OPEN, keeping lower relay_id"));
      } else {
        // 已有的 relay_id 更小或相等：保留已有的，断开新的
        conn.abort(new RelayError(RelayErrorCodes.DuplicateOpen, "concurrent OPEN, keeping lower relay_id"));
        return;
      }
    }

    this.conns.set(env.relayId, conn);
    const handler = this.onConn;

    // 回复 OPEN_ACK
    conn.sendRelayEnvelope({
      relayId: env.relayId,
      kind: ProtoRelayKind.OPEN_ACK,
      senderSession: mySession,
      targetSession: remoteSession,
      seq: "0",
      ackSeq: "0",
      payload: new Uint8Array(0),
      sentAtMs: String(Date.now()),
    }).catch(() => {});

    if (handler != null) {
      try {
        handler(conn);
      } catch {
        // 忽略处理器异常
      }
    }
  }

  /**
   * 从管理器中移除连接。
   */
  removeConnection(relayId: string): void {
    this.conns.delete(relayId);
  }
}
