/**
 * turntf SDK 的基础错误类。
 * 所有自定义错误均继承自此类，便于统一捕获和处理 SDK 相关的异常。
 */
export class TurntfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * 客户端已关闭错误。
 * 当操作在客户端关闭后被调用时抛出，表示当前客户端实例已不再可用。
 */
export class ClosedError extends TurntfError {
  constructor() {
    super("turntf client is closed");
  }
}

/**
 * 未连接错误。
 * 当尝试在尚未建立 WebSocket 连接时执行需要连接的操作时抛出。
 */
export class NotConnectedError extends TurntfError {
  constructor() {
    super("turntf client is not connected");
  }
}

/**
 * WebSocket 断开连接错误。
 * 当 WebSocket 连接在运行过程中意外断开时抛出。
 */
export class DisconnectedError extends TurntfError {
  constructor() {
    super("turntf websocket disconnected");
  }
}

/**
 * 服务器返回的错误。
 * 当服务器返回错误响应时抛出，包含错误码、描述信息和请求 ID。
 * 可通过 {@link unauthorized} 方法判断是否为未授权错误。
 */
export class ServerError extends TurntfError {
  /** 错误码，用于标识具体的错误类型 */
  readonly code: string;
  /** 请求 ID，用于追踪具体的请求 */
  readonly requestId: string;
  /** 服务器返回的原始错误消息 */
  readonly serverMessage: string;

  /**
   * 创建一个服务器错误实例。
   * @param code - 错误码
   * @param message - 错误描述信息
   * @param requestId - 请求 ID，默认为 "0"
   */
  constructor(code: string, message: string, requestId = "0") {
    super(requestId === "0"
      ? `turntf server error: ${code} (${message})`
      : `turntf server error: ${code} (${message}), request_id=${requestId}`);
    this.code = code;
    this.requestId = requestId;
    this.serverMessage = message;
  }

  /**
   * 判断是否为未授权错误（错误码为 "unauthorized"）。
   * @returns 如果是未授权错误返回 true，否则返回 false
   */
  unauthorized(): boolean {
    return this.code === "unauthorized";
  }
}

/**
 * 协议错误。
 * 当从服务器接收到无法识别或格式错误的协议数据时抛出。
 */
export class ProtocolError extends TurntfError {
  /** 协议错误消息 */
  readonly protocolMessage: string;

  /**
   * 创建一个协议错误实例。
   * @param message - 协议错误描述
   */
  constructor(message: string) {
    super(`turntf protocol error: ${message}`);
    this.protocolMessage = message;
  }
}

/**
 * 连接错误。
 * 在 WebSocket 拨号或读写过程中发生底层错误时抛出。
 * 可通过 {@link ConnectionError.op} 获取失败的操作名称。
 */
export class ConnectionError extends TurntfError {
  /** 发生错误时的操作名称（如 "dial"、"write"、"read"） */
  readonly op: string;
  /** 原始异常对象 */
  override readonly cause?: unknown;

  /**
   * 创建一个连接错误实例。
   * @param op - 发生错误时的操作名称
   * @param cause - 导致错误的原始异常
   */
  constructor(op: string, cause: unknown) {
    super(`turntf connection error during ${op}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.op = op;
    this.cause = cause;
  }
}
