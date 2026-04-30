export class TurntfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ClosedError extends TurntfError {
  constructor() {
    super("turntf client is closed");
  }
}

export class NotConnectedError extends TurntfError {
  constructor() {
    super("turntf client is not connected");
  }
}

export class DisconnectedError extends TurntfError {
  constructor() {
    super("turntf websocket disconnected");
  }
}

export class ServerError extends TurntfError {
  readonly code: string;
  readonly requestId: string;
  readonly serverMessage: string;

  constructor(code: string, message: string, requestId = "0") {
    super(requestId === "0"
      ? `turntf server error: ${code} (${message})`
      : `turntf server error: ${code} (${message}), request_id=${requestId}`);
    this.code = code;
    this.requestId = requestId;
    this.serverMessage = message;
  }

  unauthorized(): boolean {
    return this.code === "unauthorized";
  }
}

export class ProtocolError extends TurntfError {
  readonly protocolMessage: string;

  constructor(message: string) {
    super(`turntf protocol error: ${message}`);
    this.protocolMessage = message;
  }
}

export class ConnectionError extends TurntfError {
  readonly op: string;
  override readonly cause?: unknown;

  constructor(op: string, cause: unknown) {
    super(`turntf connection error during ${op}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.op = op;
    this.cause = cause;
  }
}
