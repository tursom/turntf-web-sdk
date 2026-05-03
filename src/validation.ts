import {
  type Credentials,
  DeliveryMode,
  type HTTPUpsertUserMetadataRequest,
  type HTTPUserMetadataTypedValue,
  type ListUsersRequest,
  type Message,
  type MessageCursor,
  type ScanUserMetadataRequest,
  type SessionRef,
  SystemUserMetadataKey,
  type UserRef
} from "./types";
import { bytesToUtf8, stringifyJson } from "./utils";

const unsignedDecimalPattern = /^(0|[1-9][0-9]*)$/;
const jsonNumberPattern = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;
const userMetadataKeyMaxLength = 128;
const userMetadataScanLimitMax = 1000;

/**
 * 断言字符串为非负整数的十进制表示。
 * 只允许数字字符（0-9），不能有前导零（但允许单独的 "0"）。
 *
 * @param value - 待验证的字符串
 * @param field - 字段名称，用于错误消息
 * @throws 如果值不符合十进制数字格式则抛出错误
 */
export function assertDecimalString(value: string, field: string): void {
  if (!unsignedDecimalPattern.test(value)) {
    throw new Error(`${field} must be a decimal string`);
  }
}

/**
 * 断言字符串为非零的非负整数十进制表示。
 * 相比 {@link assertDecimalString}，额外要求值不能为 "0"。
 *
 * @param value - 待验证的字符串
 * @param field - 字段名称，用于错误消息
 * @throws 如果值不是十进制数字或为 "0" 则抛出错误
 */
export function assertRequiredDecimalString(value: string, field: string): void {
  assertDecimalString(value, field);
  if (value === "0") {
    throw new Error(`${field} is required`);
  }
}

/**
 * 验证 UserRef 对象的合法性。
 * 确保 nodeId 和 userId 均为有效的非零十进制数字字符串。
 *
 * @param ref - 用户引用对象
 * @param field - 字段名称前缀，用于错误消息，默认为 "user"
 * @throws 如果引用无效则抛出错误
 */
export function validateUserRef(ref: UserRef, field = "user"): void {
  assertRequiredDecimalString(ref.nodeId, `${field}.nodeId`);
  assertRequiredDecimalString(ref.userId, `${field}.userId`);
}

/**
 * 判断 UserRef 是否为零值引用。
 * 在部分查询协议中，`{ nodeId: "0", userId: "0" }` 表示“未指定目标”。
 *
 * @param ref - 待判断的用户引用
 * @returns 如果 nodeId 和 userId 都为 "0" 则返回 true
 */
export function isZeroUserRef(ref: UserRef | undefined): boolean {
  return ref?.nodeId === "0" && ref.userId === "0";
}

/**
 * 验证 listUsers 过滤条件中的 uid。
 * 允许显式零值引用，但不允许仅提供半边字段。
 *
 * @param ref - 待验证的用户引用
 * @param field - 字段名称前缀，默认为 "uid"
 * @throws 如果 uid 非法则抛出错误
 */
export function validateListUsersUid(ref: UserRef, field = "uid"): void {
  assertDecimalString(ref.nodeId, `${field}.nodeId`);
  assertDecimalString(ref.userId, `${field}.userId`);
  const nodeIdIsZero = ref.nodeId === "0";
  const userIdIsZero = ref.userId === "0";
  if (nodeIdIsZero !== userIdIsZero) {
    throw new Error(`${field} must provide both nodeId and userId together`);
  }
}

/**
 * 验证登录名不能为空字符串。
 *
 * @param value - 登录名字符串
 * @param field - 字段名称，用于错误消息，默认为 "loginName"
 * @throws 如果登录名为空则抛出错误
 */
export function validateLoginName(value: string, field = "loginName"): void {
  if (value === "") {
    throw new Error(`${field} is required`);
  }
}

/**
 * 验证凭据对象的合法性。
 * 凭据必须是以下两种形式之一（互斥）：
 * 1. 包含 loginName 的登录名形式
 * 2. 包含 nodeId 和 userId 的用户引用形式
 *
 * @param credentials - 凭据对象
 * @param field - 字段名称前缀，用于错误消息，默认为 "credentials"
 * @throws 如果凭据格式无效则抛出错误
 */
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

/**
 * 验证 SessionRef 对象的合法性。
 * 确保 servingNodeId 为非零十进制数字字符串，且 sessionId 不为空。
 *
 * @param ref - 会话引用对象
 * @param field - 字段名称前缀，用于错误消息，默认为 "session"
 * @throws 如果会话引用无效则抛出错误
 */
export function validateSessionRef(ref: SessionRef, field = "session"): void {
  assertRequiredDecimalString(ref.servingNodeId, `${field}.servingNodeId`);
  if (ref.sessionId === "") {
    throw new Error(`${field}.sessionId is required`);
  }
}

/**
 * 验证投递模式是否合法。
 * 合法的模式为 {@link DeliveryMode.BestEffort} 或 {@link DeliveryMode.RouteRetry}。
 *
 * @param mode - 投递模式
 * @throws 如果模式不合法则抛出错误
 */
export function validateDeliveryMode(mode: DeliveryMode): void {
  if (mode !== DeliveryMode.BestEffort && mode !== DeliveryMode.RouteRetry) {
    throw new Error(`invalid deliveryMode ${JSON.stringify(mode)}`);
  }
}

/**
 * 验证用户元数据的键值是否合法。
 * 键值只能包含字母、数字和特殊字符（. _ : -），且长度不超过128个字符。
 *
 * @param key - 元数据键值
 * @param field - 字段名称，用于错误消息，默认为 "key"
 * @throws 如果键值无效则抛出错误
 */
export function validateUserMetadataKey(key: string, field = "key"): void {
  validateUserMetadataKeyFragment(key, field, false);
}

/**
 * 验证扫描用户元数据的请求参数。
 * 确保 prefix、after 符合键值格式，limit 在合法范围内，
 * 且 after 起始于 prefix（当两者同时提供时）。
 *
 * @param request - 扫描元数据请求
 * @param field - 字段名称前缀，用于错误消息，默认为 "request"
 * @throws 如果请求参数无效则抛出错误
 */
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

/**
 * 验证列用户请求。
 * `name` 允许为空白字符串，SDK 会在发请求前规范化为“未设置”。
 *
 * @param request - 列用户请求参数
 * @param field - 字段名称前缀，默认为 "request"
 */
export function validateListUsersRequest(request: ListUsersRequest, field = "request"): void {
  if (request.uid != null) {
    validateListUsersUid(request.uid, `${field}.uid`);
  }
}

/**
 * 验证 HTTP metadata typed_value 的合法性。
 *
 * @param value - typed_value 输入对象
 * @param field - 字段名称前缀，默认为 "typedValue"
 * @throws 如果 kind 或对应值不合法则抛出错误
 */
export function validateHTTPUserMetadataTypedValue(value: HTTPUserMetadataTypedValue, field = "typedValue"): void {
  switch (value.kind) {
    case "bytes":
      if (!(value.bytesValue instanceof Uint8Array)) {
        throw new Error(`${field}.bytesValue is required`);
      }
      return;
    case "bool":
      if (typeof value.boolValue !== "boolean") {
        throw new Error(`${field}.boolValue is required`);
      }
      return;
    case "string":
      if (typeof value.stringValue !== "string") {
        throw new Error(`${field}.stringValue is required`);
      }
      return;
    case "number":
      validateJSONNumberValue(value.numberValue, `${field}.numberValue`);
      return;
    case "json":
      validateHTTPUserMetadataJSONValue(value.jsonValue, `${field}.jsonValue`);
      return;
    default:
      throw new Error(`${field}.kind is unsupported`);
  }
}

/**
 * 验证 metadata value 是否符合特定系统 key 的约束。
 * 当前主要用于 `system.visible_to_others` 的布尔语义校验。
 *
 * @param key - metadata 键名
 * @param value - 原始 bytes 值
 * @param expiresAt - 可选过期时间
 * @param field - 字段名称前缀，默认为 "request"
 * @throws 如果系统键的值或 TTL 不合法则抛出错误
 */
export function validateUserMetadataValuePolicy(
  key: string,
  value: Uint8Array,
  expiresAt?: string,
  field = "request"
): void {
  if (key !== SystemUserMetadataKey.VisibleToOthers) {
    return;
  }
  if (expiresAt != null && expiresAt !== "") {
    throw new Error(`${field}.expiresAt is not supported for ${SystemUserMetadataKey.VisibleToOthers}`);
  }
  const normalized = bytesToUtf8(value).trim();
  if (normalized !== "true" && normalized !== "false") {
    throw new Error(`${field}.value must be UTF-8 "true" or "false" for ${SystemUserMetadataKey.VisibleToOthers}`);
  }
}

/**
 * 验证 HTTP metadata upsert 请求。
 * 必须且只能提供 `value` 或 `typedValue`；同时会检查系统保留 key 的语义约束。
 *
 * @param request - HTTP metadata upsert 请求
 * @param key - metadata 键名
 * @param field - 字段名称前缀，默认为 "request"
 * @throws 如果请求不合法则抛出错误
 */
export function validateHTTPUpsertUserMetadataRequest(
  request: HTTPUpsertUserMetadataRequest,
  key: string,
  field = "request"
): void {
  const hasValue = "value" in request && request.value != null;
  const hasTypedValue = "typedValue" in request && request.typedValue != null;
  if (hasValue === hasTypedValue) {
    throw new Error(`exactly one of ${field}.value or ${field}.typedValue must be provided`);
  }
  if (hasValue) {
    validateUserMetadataValuePolicy(key, request.value, request.expiresAt, field);
    return;
  }
  validateHTTPUserMetadataTypedValue(request.typedValue, `${field}.typedValue`);
  if (key !== SystemUserMetadataKey.VisibleToOthers) {
    return;
  }
  if (request.expiresAt != null && request.expiresAt !== "") {
    throw new Error(`${field}.expiresAt is not supported for ${SystemUserMetadataKey.VisibleToOthers}`);
  }
  if (request.typedValue.kind !== "bool") {
    throw new Error(`${field}.typedValue.kind must be "bool" for ${SystemUserMetadataKey.VisibleToOthers}`);
  }
}

/**
 * 从消息对象中提取游标信息。
 * 游标包含消息所在节点的 nodeId 和消息的序列号 seq。
 *
 * @param message - 消息对象
 * @returns 包含 nodeId 和 seq 的消息游标
 */
export function cursorForMessage(message: Message): MessageCursor {
  return { nodeId: message.nodeId, seq: message.seq };
}

/**
 * 将十进制数字字符串转换为 BigInt。
 * 先验证字符串格式，再进行转换。
 *
 * @param value - 十进制数字字符串
 * @param field - 字段名称，用于错误消息
 * @returns BigInt 类型的值
 * @throws 如果字符串不是有效的十进制数字则抛出错误
 */
export function toWireInteger(value: string, field: string): bigint {
  assertDecimalString(value, field);
  return BigInt(value);
}

/**
 * 将必填的十进制数字字符串转换为 BigInt。
 * 要求值不能为 "0"，验证后转换为 BigInt。
 *
 * @param value - 十进制数字字符串
 * @param field - 字段名称，用于错误消息
 * @returns BigInt 类型的值
 * @throws 如果字符串不是有效的十进制数字或为 "0" 则抛出错误
 */
export function toRequiredWireInteger(value: string, field: string): bigint {
  assertRequiredDecimalString(value, field);
  return BigInt(value);
}

/**
 * 将各种类型的 ID 值统一转换为字符串。
 * 支持 string、bigint、number 类型，null/undefined 转换为 "0"。
 *
 * @param value - ID 值
 * @returns 字符串形式的 ID
 * @throws 如果传入的是非整数的 number 值则抛出错误
 *
 * @example
 * idToString("123")      // "123"
 * idToString(BigInt(5))  // "5"
 * idToString(null)       // "0"
 */
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

function validateJSONNumberValue(value: number | bigint | string, field: string): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${field} must be a finite JSON number`);
    }
    return;
  }
  if (typeof value === "bigint") {
    return;
  }
  const normalized = value.trim();
  if (!jsonNumberPattern.test(normalized)) {
    throw new Error(`${field} must be a JSON number`);
  }
}

function validateHTTPUserMetadataJSONValue(value: unknown, field: string): void {
  const encoded = stringifyJson(value);
  if (typeof encoded !== "string") {
    throw new Error(`${field} must be JSON serializable`);
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
