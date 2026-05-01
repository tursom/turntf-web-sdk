import {
  type Credentials,
  DeliveryMode,
  type Message,
  type MessageCursor,
  type ScanUserMetadataRequest,
  type SessionRef,
  type UserRef
} from "./types";

const unsignedDecimalPattern = /^(0|[1-9][0-9]*)$/;
const userMetadataKeyMaxLength = 128;
const userMetadataScanLimitMax = 1000;

export function assertDecimalString(value: string, field: string): void {
  if (!unsignedDecimalPattern.test(value)) {
    throw new Error(`${field} must be a decimal string`);
  }
}

export function assertRequiredDecimalString(value: string, field: string): void {
  assertDecimalString(value, field);
  if (value === "0") {
    throw new Error(`${field} is required`);
  }
}

export function validateUserRef(ref: UserRef, field = "user"): void {
  assertRequiredDecimalString(ref.nodeId, `${field}.nodeId`);
  assertRequiredDecimalString(ref.userId, `${field}.userId`);
}

export function validateLoginName(value: string, field = "loginName"): void {
  if (value === "") {
    throw new Error(`${field} is required`);
  }
}

export function validateCredentials(credentials: Credentials, field = "credentials"): void {
  const hasLoginName = "loginName" in credentials;
  const hasNodeId = "nodeId" in credentials;
  const hasUserId = "userId" in credentials;

  if (hasLoginName) {
    if (hasNodeId || hasUserId) {
      throw new Error(`${field} must use either loginName or nodeId/userId`);
    }
    validateLoginName(credentials.loginName, `${field}.loginName`);
    return;
  }

  if (!hasNodeId || !hasUserId) {
    throw new Error(`${field} must provide nodeId/userId or loginName`);
  }
  validateUserRef(credentials, field);
}

export function validateSessionRef(ref: SessionRef, field = "session"): void {
  assertRequiredDecimalString(ref.servingNodeId, `${field}.servingNodeId`);
  if (ref.sessionId === "") {
    throw new Error(`${field}.sessionId is required`);
  }
}

export function validateDeliveryMode(mode: DeliveryMode): void {
  if (mode !== DeliveryMode.BestEffort && mode !== DeliveryMode.RouteRetry) {
    throw new Error(`invalid deliveryMode ${JSON.stringify(mode)}`);
  }
}

export function validateUserMetadataKey(key: string, field = "key"): void {
  validateUserMetadataKeyFragment(key, field, false);
}

export function validateUserMetadataScanRequest(request: ScanUserMetadataRequest, field = "request"): void {
  const prefix = request.prefix ?? "";
  const after = request.after ?? "";

  validateUserMetadataKeyFragment(prefix, `${field}.prefix`, true);
  validateUserMetadataKeyFragment(after, `${field}.after`, true);

  if (request.limit != null) {
    validateUserMetadataScanLimit(request.limit, `${field}.limit`);
  }
  if (after !== "" && prefix !== "" && !after.startsWith(prefix)) {
    throw new Error(`${field}.after must use the same prefix as ${field}.prefix`);
  }
}

export function cursorForMessage(message: Message): MessageCursor {
  return { nodeId: message.nodeId, seq: message.seq };
}

export function toWireInteger(value: string, field: string): bigint {
  assertDecimalString(value, field);
  return BigInt(value);
}

export function toRequiredWireInteger(value: string, field: string): bigint {
  assertRequiredDecimalString(value, field);
  return BigInt(value);
}

export function idToString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new Error(`invalid integer value ${value}`);
    }
    return String(value);
  }
  if (value == null) {
    return "0";
  }
  return String(value);
}

function validateUserMetadataScanLimit(value: number, field: string): void {
  if (!Number.isInteger(value)) {
    throw new Error(`${field} must be an integer`);
  }
  if (value < 0) {
    throw new Error(`${field} must be non-negative`);
  }
  if (value > userMetadataScanLimitMax) {
    throw new Error(`${field} cannot exceed ${userMetadataScanLimitMax}`);
  }
}

function validateUserMetadataKeyFragment(value: string, field: string, allowEmpty: boolean): void {
  if (value === "") {
    if (allowEmpty) {
      return;
    }
    throw new Error(`${field} cannot be empty`);
  }
  if (value.length > userMetadataKeyMaxLength) {
    throw new Error(`${field} cannot exceed ${userMetadataKeyMaxLength} characters`);
  }
  for (const ch of value) {
    switch (true) {
      case ch >= "a" && ch <= "z":
      case ch >= "A" && ch <= "Z":
      case ch >= "0" && ch <= "9":
      case ch === ".":
      case ch === "_":
      case ch === ":":
      case ch === "-":
        break;
      default:
        throw new Error(`${field} contains unsupported character ${JSON.stringify(ch)}`);
    }
  }
}
