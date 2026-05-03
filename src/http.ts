import { ConnectionError, ProtocolError } from "./errors";
import { passwordWireValue, plainPassword, type PasswordInput } from "./password";
import {
  AttachmentType,
  type Attachment,
  type BlacklistEntry,
  type ClusterNode,
  type CreateUserRequest,
  type DeleteUserResult,
  DeliveryMode,
  type Event,
  type ListUsersRequest,
  type LoggedInUser,
  type Message,
  type OperationsStatus,
  type PeerOriginStatus,
  type PeerStatus,
  type ProjectionStatus,
  type RequestOptions,
  type ScanUserMetadataRequest,
  type ScanUserMetadataResult,
  type Subscription,
  type UpdateUserRequest,
  type User,
  type UserMetadata,
  type UpsertUserMetadataRequest,
  type UserRef
} from "./types";
import {
  base64ToBytes,
  bytesToBase64,
  bytesToUtf8,
  mergeAbortSignals,
  parseJson,
  readResponseText,
  stringifyJson,
  utf8ToBytes
} from "./utils";
import {
  idToString,
  isZeroUserRef,
  toRequiredWireInteger,
  toWireInteger,
  validateDeliveryMode,
  validateLoginName,
  validateListUsersRequest,
  validateUserMetadataKey,
  validateUserMetadataScanRequest,
  validateUserRef
} from "./validation";

/**
 * HTTP 客户端选项。
 */
export interface HTTPClientOptions {
  /** 自定义的 fetch 实现，可用于 Node.js 等不支持全局 fetch 的环境 */
  fetch?: typeof fetch;
}

/**
 * turntf 的 HTTP API 客户端。
 * 提供与 turntf 服务器通信的 REST API 封装，包括认证、用户管理、消息收发、
 * 元数据操作、附件管理、频道订阅、集群管理等。
 *
 * 所有返回 Promise 的方法均可通过 {@link RequestOptions} 控制超时和取消。
 *
 * @example
 * const client = new HTTPClient("https://turntf.example.com");
 * const token = await client.login("1", "1001", "password");
 */
export class HTTPClient {
  /** 服务器基础 URL */
  readonly baseUrl: string;
  private fetchImpl: typeof globalThis.fetch;

  /**
   * 创建一个 HTTPClient 实例。
   * @param baseUrl - 服务器基础 URL（如 "https://turntf.example.com"）
   * @param options - 可选的客户端配置
   * @throws 如果 baseUrl 为空或 fetch 不可用则抛出错误
   */
  constructor(baseUrl: string, options: HTTPClientOptions = {}) {
    if (baseUrl.trim() === "") {
      throw new Error("baseUrl is required");
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    const fetchImpl = options.fetch ?? bindDefaultFetch();
    if (fetchImpl == null) {
      throw new Error("fetch is required");
    }
    this.fetchImpl = fetchImpl;
  }

  /**
   * 使用用户 ID 和密码登录。
   * 密码将自动进行 bcrypt 哈希处理。
   *
   * @param nodeId - 用户所属节点 ID
   * @param userId - 用户 ID
   * @param password - 原始密码字符串
   * @param options - 可选的请求配置
   * @returns 认证令牌（Bearer token）
   */
  async login(nodeId: string, userId: string, password: string, options?: RequestOptions): Promise<string> {
    return this.loginWithPassword(nodeId, userId, await plainPassword(password), options);
  }

  /**
   * 使用登录名和密码登录。
   * 密码将自动进行 bcrypt 哈希处理。
   *
   * @param loginName - 登录名
   * @param password - 原始密码字符串
   * @param options - 可选的请求配置
   * @returns 认证令牌（Bearer token）
   */
  async loginByLoginName(loginName: string, password: string, options?: RequestOptions): Promise<string> {
    return this.loginByLoginNameWithPassword(loginName, await plainPassword(password), options);
  }

  /**
   * 使用用户 ID 和预处理的密码输入对象登录。
   * 适用于密码已在外部完成 bcrypt 哈希的场景。
   *
   * @param nodeId - 用户所属节点 ID
   * @param userId - 用户 ID
   * @param password - 密码输入对象（使用 {@link plainPassword} 或 {@link hashedPassword} 创建）
   * @param options - 可选的请求配置
   * @returns 认证令牌（Bearer token）
   */
  async loginWithPassword(
    nodeId: string,
    userId: string,
    password: PasswordInput,
    options?: RequestOptions
  ): Promise<string> {
    const response = await this.doJSON(
      "POST",
      "/auth/login",
      "",
      {
        node_id: toRequiredWireInteger(nodeId, "nodeId"),
        user_id: toRequiredWireInteger(userId, "userId"),
        password: passwordWireValue(password)
      },
      [200],
      options
    );
    const token = objectField(response, "token");
    if (typeof token !== "string" || token === "") {
      throw new ProtocolError("empty token in login response");
    }
    return token;
  }

  /**
   * 使用登录名和预处理的密码输入对象登录。
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
    validateLoginName(loginName);
    const response = await this.doJSON(
      "POST",
      "/auth/login",
      "",
      {
        login_name: loginName,
        password: passwordWireValue(password)
      },
      [200],
      options
    );
    const token = objectField(response, "token");
    if (typeof token !== "string" || token === "") {
      throw new ProtocolError("empty token in login response");
    }
    return token;
  }

  /**
   * 创建新用户。
   *
   * @param token - 认证令牌
   * @param request - 创建用户请求参数
   * @param options - 可选的请求配置
   * @returns 创建后的用户对象
   * @throws 如果 username 或 role 为空则抛出错误
   */
  async createUser(token: string, request: CreateUserRequest, options?: RequestOptions): Promise<User> {
    if (request.username === "") {
      throw new Error("username is required");
    }
    if (request.role === "") {
      throw new Error("role is required");
    }

    const body: Record<string, unknown> = {
      username: request.username,
      role: request.role
    };
    if (request.password != null) {
      body.password = passwordWireValue(request.password);
    }
    if (request.profileJson != null && request.profileJson.length > 0) {
      body.profile = parseJson(bytesToUtf8(request.profileJson));
    }
    if (request.loginName != null) {
      body.login_name = request.loginName;
    }

    const response = await this.doJSON("POST", "/users", token, body, [200, 201], options);
    return userFromHTTP(response);
  }

  /**
   * 创建频道（角色默认为 "channel"）。
   * 是 {@link createUser} 的便捷方法，自动设置 role 为 "channel"。
   *
   * @param token - 认证令牌
   * @param request - 创建频道的请求参数（无需提供 role）
   * @param options - 可选的请求配置
   * @returns 创建后的频道用户对象
   */
  createChannel(
    token: string,
    request: Omit<CreateUserRequest, "role"> & Partial<Pick<CreateUserRequest, "role">>,
    options?: RequestOptions
  ): Promise<User> {
    return this.createUser(token, { ...request, role: request.role ?? "channel" }, options);
  }

  /**
   * 获取用户信息。
   *
   * @param token - 认证令牌
   * @param target - 目标用户引用
   * @param options - 可选的请求配置
   * @returns 用户对象
   */
  async getUser(token: string, target: UserRef, options?: RequestOptions): Promise<User> {
    validateUserRef(target, "target");
    const response = await this.doJSON(
      "GET",
      `/nodes/${target.nodeId}/users/${target.userId}`,
      token,
      undefined,
      [200],
      options
    );
    return userFromHTTP(response);
  }

  /**
   * 获取当前用户可通讯的活跃用户列表。
   * 支持按名称子串和用户唯一标识过滤。
   *
   * @param token - 认证令牌
   * @param request - 可选过滤条件
   * @param options - 可选的请求配置
   * @returns 用户列表
   */
  async listUsers(token: string, request: ListUsersRequest = {}, options?: RequestOptions): Promise<User[]> {
    validateListUsersRequest(request, "request");

    const params = new URLSearchParams();
    const name = normalizeListUsersName(request.name);
    if (name !== undefined) {
      params.set("name", name);
    }
    const uid = uidFilterToHTTP(request.uid);
    if (uid !== undefined) {
      params.set("uid", uid);
    }
    const suffix = params.size === 0 ? "" : `?${params.toString()}`;

    const response = await this.doJSON("GET", `/users${suffix}`, token, undefined, [200], options);
    const items = Array.isArray(response) ? response : itemsField(response, ["items"]);
    return items.map(userFromHTTP);
  }

  /**
   * 更新用户信息。
   * 仅更新请求中提供的字段，未提供的字段保持不变。
   *
   * @param token - 认证令牌
   * @param target - 目标用户引用
   * @param request - 更新请求参数（所有字段可选）
   * @param options - 可选的请求配置
   * @returns 更新后的用户对象
   */
  async updateUser(token: string, target: UserRef, request: UpdateUserRequest, options?: RequestOptions): Promise<User> {
    validateUserRef(target, "target");

    const body: Record<string, unknown> = {};
    if (request.username != null) {
      body.username = request.username;
    }
    if (request.password != null) {
      body.password = passwordWireValue(request.password);
    }
    if (request.profileJson != null) {
      body.profile = parseJson(bytesToUtf8(request.profileJson));
    }
    if (request.role != null) {
      body.role = request.role;
    }
    if (request.loginName != null) {
      body.login_name = request.loginName;
    }

    const response = await this.doJSON(
      "PATCH",
      `/nodes/${target.nodeId}/users/${target.userId}`,
      token,
      body,
      [200],
      options
    );
    return userFromHTTP(response);
  }

  /**
   * 删除用户。
   *
   * @param token - 认证令牌
   * @param target - 目标用户引用
   * @param options - 可选的请求配置
   * @returns 删除操作结果
   */
  async deleteUser(token: string, target: UserRef, options?: RequestOptions): Promise<DeleteUserResult> {
    validateUserRef(target, "target");
    const response = await this.doJSON(
      "DELETE",
      `/nodes/${target.nodeId}/users/${target.userId}`,
      token,
      undefined,
      [200],
      options
    );
    return deleteUserResultFromHTTP(response);
  }

  /**
   * 获取用户元数据。
   *
   * @param token - 认证令牌
   * @param owner - 元数据所有者的用户引用
   * @param key - 元数据键名
   * @param options - 可选的请求配置
   * @returns 用户元数据对象
   */
  async getUserMetadata(token: string, owner: UserRef, key: string, options?: RequestOptions): Promise<UserMetadata> {
    validateUserRef(owner, "owner");
    validateUserMetadataKey(key);

    const response = await this.doJSON(
      "GET",
      `/nodes/${owner.nodeId}/users/${owner.userId}/metadata/${encodeURIComponent(key)}`,
      token,
      undefined,
      [200],
      options
    );
    return userMetadataFromHTTP(response);
  }

  /**
   * 插入或更新用户元数据。
   * 如果键已存在则更新，不存在则创建。
   *
   * @param token - 认证令牌
   * @param owner - 元数据所有者的用户引用
   * @param key - 元数据键名
   * @param request - 更新请求参数
   * @param options - 可选的请求配置
   * @returns 更新后的用户元数据对象
   */
  async upsertUserMetadata(
    token: string,
    owner: UserRef,
    key: string,
    request: UpsertUserMetadataRequest,
    options?: RequestOptions
  ): Promise<UserMetadata> {
    validateUserRef(owner, "owner");
    validateUserMetadataKey(key);

    const body: Record<string, unknown> = {
      value: bytesToBase64(request.value)
    };
    if (request.expiresAt != null) {
      body.expires_at = request.expiresAt;
    }

    const response = await this.doJSON(
      "PUT",
      `/nodes/${owner.nodeId}/users/${owner.userId}/metadata/${encodeURIComponent(key)}`,
      token,
      body,
      [200, 201],
      options
    );
    return userMetadataFromHTTP(response);
  }

  /**
   * 删除用户元数据。
   *
   * @param token - 认证令牌
   * @param owner - 元数据所有者的用户引用
   * @param key - 元数据键名
   * @param options - 可选的请求配置
   * @returns 被删除的用户元数据对象
   */
  async deleteUserMetadata(token: string, owner: UserRef, key: string, options?: RequestOptions): Promise<UserMetadata> {
    validateUserRef(owner, "owner");
    validateUserMetadataKey(key);

    const response = await this.doJSON(
      "DELETE",
      `/nodes/${owner.nodeId}/users/${owner.userId}/metadata/${encodeURIComponent(key)}`,
      token,
      undefined,
      [200],
      options
    );
    return userMetadataFromHTTP(response);
  }

  /**
   * 扫描用户元数据。
   * 支持按前缀过滤和分页查询。
   *
   * @param token - 认证令牌
   * @param owner - 元数据所有者的用户引用
   * @param request - 扫描请求参数（可选，默认扫描全部）
   * @param options - 可选的请求配置
   * @returns 扫描结果，包含条目列表和下一页游标
   */
  async scanUserMetadata(
    token: string,
    owner: UserRef,
    request: ScanUserMetadataRequest = {},
    options?: RequestOptions
  ): Promise<ScanUserMetadataResult> {
    validateUserRef(owner, "owner");
    validateUserMetadataScanRequest(request);

    const params = new URLSearchParams();
    if (request.prefix != null && request.prefix !== "") {
      params.set("prefix", request.prefix);
    }
    if (request.after != null && request.after !== "") {
      params.set("after", request.after);
    }
    if (request.limit != null && request.limit > 0) {
      params.set("limit", String(request.limit));
    }
    const suffix = params.size === 0 ? "" : `?${params.toString()}`;

    const response = await this.doJSON(
      "GET",
      `/nodes/${owner.nodeId}/users/${owner.userId}/metadata${suffix}`,
      token,
      undefined,
      [200],
      options
    );
    return userMetadataScanResultFromHTTP(response);
  }

  /**
   * 创建频道订阅。
   *
   * @param token - 认证令牌
   * @param user - 订阅者用户引用
   * @param channel - 频道用户引用
   * @param options - 可选的请求配置
   * @returns 订阅关系对象
   */
  async createSubscription(token: string, user: UserRef, channel: UserRef, options?: RequestOptions): Promise<Subscription> {
    const attachment = await this.upsertAttachment(
      token,
      user,
      channel,
      AttachmentType.ChannelSubscription,
      new Uint8Array(0),
      options
    );
    return subscriptionFromAttachment(attachment);
  }

  /**
   * 订阅频道（{@link createSubscription} 的别名）。
   *
   * @param token - 认证令牌
   * @param subscriber - 订阅者用户引用
   * @param channel - 频道用户引用
   * @param options - 可选的请求配置
   * @returns 订阅关系对象
   */
  subscribeChannel(token: string, subscriber: UserRef, channel: UserRef, options?: RequestOptions): Promise<Subscription> {
    return this.createSubscription(token, subscriber, channel, options);
  }

  /**
   * 取消频道订阅。
   *
   * @param token - 认证令牌
   * @param subscriber - 订阅者用户引用
   * @param channel - 频道用户引用
   * @param options - 可选的请求配置
   * @returns 被取消的订阅关系对象
   */
  async unsubscribeChannel(token: string, subscriber: UserRef, channel: UserRef, options?: RequestOptions): Promise<Subscription> {
    const attachment = await this.deleteAttachment(token, subscriber, channel, AttachmentType.ChannelSubscription, options);
    return subscriptionFromAttachment(attachment);
  }

  /**
   * 列出用户的所有频道订阅。
   *
   * @param token - 认证令牌
   * @param subscriber - 订阅者用户引用
   * @param options - 可选的请求配置
   * @returns 订阅关系对象数组
   */
  async listSubscriptions(token: string, subscriber: UserRef, options?: RequestOptions): Promise<Subscription[]> {
    const items = await this.listAttachments(token, subscriber, AttachmentType.ChannelSubscription, options);
    return items.map(subscriptionFromAttachment);
  }

  /**
   * 列出用户的消息列表。
   *
   * @param token - 认证令牌
   * @param target - 目标用户引用
   * @param limit - 返回的最大消息数量（0 表示不限制）
   * @param peerNodeId - 可选，会话对方 node_id（与 peerUserId 同时提供时启用 session 查询）
   * @param peerUserId - 可选，会话对方 user_id
   * @param options - 可选的请求配置
   * @returns 消息对象数组
   */
  async listMessages(token: string, target: UserRef, limit = 0, peerNodeId?: string, peerUserId?: string, options?: RequestOptions): Promise<Message[]> {
    if (target.nodeId !== "0" || target.userId !== "0") {
      validateUserRef(target, "target");
    }
    validateLimit(limit, "limit");
    const params: string[] = [];
    if (limit > 0) params.push(`limit=${encodeURIComponent(String(limit))}`);
    if (peerNodeId !== undefined && peerUserId !== undefined) {
      params.push(`peer_node_id=${encodeURIComponent(peerNodeId)}`);
      params.push(`peer_user_id=${encodeURIComponent(peerUserId)}`);
    }
    const query = params.length > 0 ? `?${params.join("&")}` : "";
    const response = await this.doJSON(
      "GET",
      `/nodes/${target.nodeId}/users/${target.userId}/messages${query}`,
      token,
      undefined,
      [200],
      options
    );
    return itemsField(response, ["items"]).map(messageFromHTTP);
  }

  /**
   * 发送持久化消息。
   * 消息将被持久化存储，断线后用户仍可收到。
   *
   * @param token - 认证令牌
   * @param target - 目标用户引用
   * @param body - 消息体字节数据
   * @param options - 可选的请求配置
   * @returns 发送后的消息对象
   * @throws 如果消息体为空则抛出错误
   */
  async postMessage(token: string, target: UserRef, body: Uint8Array, options?: RequestOptions): Promise<Message> {
    validateUserRef(target, "target");
    if (body.length === 0) {
      throw new Error("body is required");
    }

    const response = await this.doJSON(
      "POST",
      `/nodes/${target.nodeId}/users/${target.userId}/messages`,
      token,
      { body: bytesToBase64(body) },
      [200, 201],
      options
    );
    return messageFromHTTP(response);
  }

  /**
   * 发送瞬时数据包（中继消息）。
   * 数据包不会被持久化，适用于实时消息推送场景。
   *
   * @param token - 认证令牌
   * @param targetNodeId - 目标节点 ID（必须与 relayTarget.nodeId 一致）
   * @param relayTarget - 接收者的用户引用
   * @param body - 数据包体字节数据
   * @param mode - 投递模式
   * @param options - 可选的请求配置
   * @throws 如果 targetNodeId 与 relayTarget.nodeId 不匹配或 body 为空则抛出错误
   */
  async postPacket(
    token: string,
    targetNodeId: string,
    relayTarget: UserRef,
    body: Uint8Array,
    mode: DeliveryMode,
    options?: RequestOptions
  ): Promise<void> {
    toRequiredWireInteger(targetNodeId, "targetNodeId");
    validateUserRef(relayTarget, "relayTarget");
    if (targetNodeId !== relayTarget.nodeId) {
      throw new Error(`target node ID ${targetNodeId} does not match target user nodeId ${relayTarget.nodeId}`);
    }
    if (body.length === 0) {
      throw new Error("body is required");
    }
    validateDeliveryMode(mode);

    await this.doJSON(
      "POST",
      `/nodes/${relayTarget.nodeId}/users/${relayTarget.userId}/messages`,
      token,
      {
        body: bytesToBase64(body),
        delivery_kind: "transient",
        delivery_mode: mode
      },
      [202],
      options
    );
  }

  /**
   * 列出集群中的所有节点。
   *
   * @param token - 认证令牌
   * @param options - 可选的请求配置
   * @returns 集群节点对象数组
   */
  async listClusterNodes(token: string, options?: RequestOptions): Promise<ClusterNode[]> {
    const response = await this.doJSON("GET", "/cluster/nodes", token, undefined, [200], options);
    return itemsField(response, ["nodes", "items"]).map(clusterNodeFromHTTP);
  }

  /**
   * 列出指定节点上当前已登录的用户。
   *
   * @param token - 认证令牌
   * @param nodeId - 节点 ID
   * @param options - 可选的请求配置
   * @returns 已登录用户对象数组
   */
  async listNodeLoggedInUsers(token: string, nodeId: string, options?: RequestOptions): Promise<LoggedInUser[]> {
    toRequiredWireInteger(nodeId, "nodeId");
    const response = await this.doJSON(
      "GET",
      `/cluster/nodes/${nodeId}/logged-in-users`,
      token,
      undefined,
      [200],
      options
    );
    return itemsField(response, ["items"]).map(loggedInUserFromHTTP);
  }

  /**
   * 屏蔽（拉黑）用户。
   *
   * @param token - 认证令牌
   * @param owner - 执行屏蔽操作的用户引用
   * @param blocked - 被屏蔽的用户引用
   * @param options - 可选的请求配置
   * @returns 黑名单条目对象
   */
  async blockUser(token: string, owner: UserRef, blocked: UserRef, options?: RequestOptions): Promise<BlacklistEntry> {
    const attachment = await this.upsertAttachment(token, owner, blocked, AttachmentType.UserBlacklist, new Uint8Array(0), options);
    return blacklistEntryFromAttachment(attachment);
  }

  /**
   * 取消屏蔽（解除拉黑）用户。
   *
   * @param token - 认证令牌
   * @param owner - 执行解除屏蔽操作的用户引用
   * @param blocked - 被解除屏蔽的用户引用
   * @param options - 可选的请求配置
   * @returns 被删除的黑名单条目对象
   */
  async unblockUser(token: string, owner: UserRef, blocked: UserRef, options?: RequestOptions): Promise<BlacklistEntry> {
    const attachment = await this.deleteAttachment(token, owner, blocked, AttachmentType.UserBlacklist, options);
    return blacklistEntryFromAttachment(attachment);
  }

  /**
   * 列出用户的黑名单列表。
   *
   * @param token - 认证令牌
   * @param owner - 要查询黑名单的用户引用
   * @param options - 可选的请求配置
   * @returns 黑名单条目对象数组
   */
  async listBlockedUsers(token: string, owner: UserRef, options?: RequestOptions): Promise<BlacklistEntry[]> {
    const items = await this.listAttachments(token, owner, AttachmentType.UserBlacklist, options);
    return items.map(blacklistEntryFromAttachment);
  }

  /**
   * 插入或更新附件关系。
   * 附件用于管理用户之间的关联关系（如频道订阅、管理员、黑名单等）。
   *
   * @param token - 认证令牌
   * @param owner - 附件所有者（关系主体）
   * @param subject - 附件目标（关系客体）
   * @param attachmentType - 附件类型
   * @param configJson - 附件配置的 JSON 字节数据（可选，默认空对象）
   * @param options - 可选的请求配置
   * @returns 附件对象
   */
  async upsertAttachment(
    token: string,
    owner: UserRef,
    subject: UserRef,
    attachmentType: AttachmentType,
    configJson = new Uint8Array(),
    options?: RequestOptions
  ): Promise<Attachment> {
    validateUserRef(owner, "owner");
    validateUserRef(subject, "subject");
    const response = await this.doJSON(
      "PUT",
      `/nodes/${owner.nodeId}/users/${owner.userId}/attachments/${attachmentType}/${subject.nodeId}/${subject.userId}`,
      token,
      {
        config_json: configJson.length === 0 ? {} : parseJson(bytesToUtf8(configJson))
      },
      [200, 201],
      options
    );
    return attachmentFromHTTP(response);
  }

  /**
   * 删除附件关系。
   *
   * @param token - 认证令牌
   * @param owner - 附件所有者
   * @param subject - 附件目标
   * @param attachmentType - 附件类型
   * @param options - 可选的请求配置
   * @returns 被删除的附件对象
   */
  async deleteAttachment(
    token: string,
    owner: UserRef,
    subject: UserRef,
    attachmentType: AttachmentType,
    options?: RequestOptions
  ): Promise<Attachment> {
    validateUserRef(owner, "owner");
    validateUserRef(subject, "subject");
    const response = await this.doJSON(
      "DELETE",
      `/nodes/${owner.nodeId}/users/${owner.userId}/attachments/${attachmentType}/${subject.nodeId}/${subject.userId}`,
      token,
      undefined,
      [200],
      options
    );
    return attachmentFromHTTP(response);
  }

  /**
   * 列出附件关系。
   * 可按附件类型过滤。
   *
   * @param token - 认证令牌
   * @param owner - 附件所有者
   * @param attachmentType - 可选的附件类型过滤条件
   * @param options - 可选的请求配置
   * @returns 附件对象数组
   */
  async listAttachments(token: string, owner: UserRef, attachmentType?: AttachmentType, options?: RequestOptions): Promise<Attachment[]> {
    validateUserRef(owner, "owner");
    const query = attachmentType ? `?attachment_type=${encodeURIComponent(attachmentType)}` : "";
    const response = await this.doJSON(
      "GET",
      `/nodes/${owner.nodeId}/users/${owner.userId}/attachments${query}`,
      token,
      undefined,
      [200],
      options
    );
    return itemsField(response, ["items"]).map(attachmentFromHTTP);
  }

  /**
   * 列出集群事件（事件溯源）。
   *
   * @param token - 认证令牌
   * @param after - 从指定序列号之后开始查询，默认 "0"（从头开始）
   * @param limit - 返回的最大事件数量（0 表示不限制）
   * @param options - 可选的请求配置
   * @returns 事件对象数组
   */
  async listEvents(token: string, after = "0", limit = 0, options?: RequestOptions): Promise<Event[]> {
    toWireInteger(after, "after");
    validateLimit(limit, "limit");

    const params = new URLSearchParams();
    if (after !== "0") {
      params.set("after", after);
    }
    if (limit > 0) {
      params.set("limit", String(limit));
    }
    const suffix = params.size === 0 ? "" : `?${params.toString()}`;

    const response = await this.doJSON("GET", `/events${suffix}`, token, undefined, [200], options);
    return itemsField(response, ["items"]).map(eventFromHTTP);
  }

  /**
   * 获取节点操作状态。
   * 返回包含消息窗口、事件序列、冲突统计和对等节点状态等信息。
   *
   * @param token - 认证令牌
   * @param options - 可选的请求配置
   * @returns 节点操作状态对象
   */
  async operationsStatus(token: string, options?: RequestOptions): Promise<OperationsStatus> {
    const response = await this.doJSON("GET", "/ops/status", token, undefined, [200], options);
    return operationsStatusFromHTTP(response);
  }

  /**
   * 获取 Prometheus 格式的监控指标。
   *
   * @param token - 认证令牌
   * @param options - 可选的请求配置
   * @returns Prometheus 格式的指标文本
   */
  async metrics(token: string, options?: RequestOptions): Promise<string> {
    return this.doText("GET", "/metrics", token, [200], options);
  }

  private async doJSON(
    method: string,
    path: string,
    token: string,
    body: unknown,
    statuses: number[],
    options?: RequestOptions
  ): Promise<unknown> {
    const abort = mergeAbortSignals(options);
    try {
      const headers: Record<string, string> = {};
      let payload: string | undefined;

      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        payload = stringifyJson(body);
      }
      if (token !== "") {
        headers.Authorization = `Bearer ${token}`;
      }

      const request: RequestInit = {
        method,
        headers,
        signal: abort.signal
      };
      if (payload !== undefined) {
        request.body = payload;
      }

      const response = await this.fetchImpl(this.baseUrl + path, request);
      const text = await readResponseText(response);
      if (!statuses.includes(response.status)) {
        throw new ProtocolError(`unexpected HTTP status ${response.status}: ${text.trim()}`);
      }
      if (text.trim() === "") {
        return undefined;
      }
      return parseJson(text);
    } catch (error) {
      if (error instanceof ProtocolError) {
        throw error;
      }
      throw new ConnectionError(`${method} ${path}`, error);
    } finally {
      abort.cleanup();
    }
  }

  private async doText(
    method: string,
    path: string,
    token: string,
    statuses: number[],
    options?: RequestOptions
  ): Promise<string> {
    const abort = mergeAbortSignals(options);
    try {
      const headers: Record<string, string> = {};
      if (token !== "") {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers,
        signal: abort.signal
      });
      const text = await readResponseText(response);
      if (!statuses.includes(response.status)) {
        throw new ProtocolError(`unexpected HTTP status ${response.status}: ${text.trim()}`);
      }
      return text;
    } catch (error) {
      if (error instanceof ProtocolError) {
        throw error;
      }
      throw new ConnectionError(`${method} ${path}`, error);
    } finally {
      abort.cleanup();
    }
  }
}

function validateLimit(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
}

function normalizeListUsersName(name: string | undefined): string | undefined {
  if (name == null) {
    return undefined;
  }
  const normalized = name.trim();
  return normalized === "" ? undefined : normalized;
}

function uidFilterToHTTP(uid: UserRef | undefined): string | undefined {
  if (uid == null || isZeroUserRef(uid)) {
    return undefined;
  }
  return `${uid.nodeId}:${uid.userId}`;
}

function bindDefaultFetch(): typeof fetch | undefined {
  const fetchImpl = globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return undefined;
  }
  return fetchImpl.bind(globalThis) as typeof fetch;
}

function itemsField(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  for (const key of keys) {
    const field = objectField(value, key);
    if (Array.isArray(field)) {
      return field;
    }
  }
  return [];
}

function objectField(value: unknown, field: string): unknown {
  if (value == null || typeof value !== "object") {
    return undefined;
  }
  return (value as Record<string, unknown>)[field];
}

function userRefFromHTTP(value: unknown): UserRef {
  return {
    nodeId: idToString(objectField(value, "node_id")),
    userId: idToString(objectField(value, "user_id"))
  };
}

function userFromHTTP(value: unknown): User {
  const profile = objectField(value, "profile") ?? objectField(value, "profile_json");
  return {
    nodeId: idToString(objectField(value, "node_id")),
    userId: idToString(objectField(value, "user_id")),
    username: String(objectField(value, "username") ?? ""),
    loginName: String(objectField(value, "login_name") ?? ""),
    role: String(objectField(value, "role") ?? ""),
    profileJson: jsonValueToBytes(profile),
    systemReserved: Boolean(objectField(value, "system_reserved")),
    createdAt: String(objectField(value, "created_at") ?? ""),
    updatedAt: String(objectField(value, "updated_at") ?? ""),
    originNodeId: idToString(objectField(value, "origin_node_id"))
  };
}

function messageFromHTTP(value: unknown): Message {
  return {
    recipient: userRefFromHTTP(objectField(value, "recipient")),
    nodeId: idToString(objectField(value, "node_id")),
    seq: idToString(objectField(value, "seq")),
    sender: userRefFromHTTP(objectField(value, "sender")),
    body: messageBodyFromHTTP(objectField(value, "body")),
    createdAtHlc: String(objectField(value, "created_at_hlc") ?? objectField(value, "created_at") ?? "")
  };
}

function attachmentFromHTTP(value: unknown): Attachment {
  return {
    owner: userRefFromHTTP(objectField(value, "owner")),
    subject: userRefFromHTTP(objectField(value, "subject")),
    attachmentType: attachmentTypeFromHTTP(objectField(value, "attachment_type")),
    configJson: jsonValueToBytes(objectField(value, "config_json"), true),
    attachedAt: String(objectField(value, "attached_at") ?? ""),
    deletedAt: String(objectField(value, "deleted_at") ?? ""),
    originNodeId: idToString(objectField(value, "origin_node_id"))
  };
}

function userMetadataFromHTTP(value: unknown): UserMetadata {
  return {
    owner: userRefFromHTTP(objectField(value, "owner")),
    key: String(objectField(value, "key") ?? ""),
    value: binaryBodyFromHTTP(objectField(value, "value")),
    updatedAt: String(objectField(value, "updated_at") ?? ""),
    deletedAt: String(objectField(value, "deleted_at") ?? ""),
    expiresAt: String(objectField(value, "expires_at") ?? ""),
    originNodeId: idToString(objectField(value, "origin_node_id"))
  };
}

function userMetadataScanResultFromHTTP(value: unknown): ScanUserMetadataResult {
  const items = itemsField(objectField(value, "items"), []);
  return {
    items: items.map(userMetadataFromHTTP),
    count: numberField(objectField(value, "count") ?? items.length),
    nextAfter: String(objectField(value, "next_after") ?? "")
  };
}

function eventFromHTTP(value: unknown): Event {
  return {
    sequence: idToString(objectField(value, "sequence")),
    eventId: idToString(objectField(value, "event_id")),
    eventType: String(objectField(value, "event_type") ?? ""),
    aggregate: String(objectField(value, "aggregate") ?? ""),
    aggregateNodeId: idToString(objectField(value, "aggregate_node_id")),
    aggregateId: idToString(objectField(value, "aggregate_id")),
    hlc: String(objectField(value, "hlc") ?? ""),
    originNodeId: idToString(objectField(value, "origin_node_id")),
    eventJson: jsonValueToBytes(objectField(value, "event") ?? objectField(value, "event_json"))
  };
}

function clusterNodeFromHTTP(value: unknown): ClusterNode {
  return {
    nodeId: idToString(objectField(value, "node_id")),
    isLocal: Boolean(objectField(value, "is_local")),
    configuredUrl: String(objectField(value, "configured_url") ?? ""),
    source: String(objectField(value, "source") ?? "")
  };
}

function loggedInUserFromHTTP(value: unknown): LoggedInUser {
  return {
    nodeId: idToString(objectField(value, "node_id")),
    userId: idToString(objectField(value, "user_id")),
    username: String(objectField(value, "username") ?? ""),
    loginName: String(objectField(value, "login_name") ?? "")
  };
}

function operationsStatusFromHTTP(value: unknown): OperationsStatus {
  return {
    nodeId: idToString(objectField(value, "node_id")),
    messageWindowSize: numberField(objectField(value, "message_window_size")),
    lastEventSequence: idToString(objectField(value, "last_event_sequence")),
    writeGateReady: Boolean(objectField(value, "write_gate_ready")),
    conflictTotal: idToString(objectField(value, "conflict_total")),
    messageTrim: messageTrimStatusFromHTTP(objectField(value, "message_trim")),
    projection: projectionStatusFromHTTP(objectField(value, "projection")),
    peers: itemsField(objectField(value, "peers"), []).map(peerStatusFromHTTP)
  };
}

function messageTrimStatusFromHTTP(value: unknown): OperationsStatus["messageTrim"] {
  return {
    trimmedTotal: idToString(objectField(value, "trimmed_total")),
    lastTrimmedAt: String(objectField(value, "last_trimmed_at") ?? "")
  };
}

function projectionStatusFromHTTP(value: unknown): ProjectionStatus {
  return {
    pendingTotal: idToString(objectField(value, "pending_total")),
    lastFailedAt: String(objectField(value, "last_failed_at") ?? "")
  };
}

function peerOriginStatusFromHTTP(value: unknown): PeerOriginStatus {
  return {
    originNodeId: idToString(objectField(value, "origin_node_id")),
    ackedEventId: idToString(objectField(value, "acked_event_id")),
    appliedEventId: idToString(objectField(value, "applied_event_id")),
    unconfirmedEvents: idToString(objectField(value, "unconfirmed_events")),
    cursorUpdatedAt: String(objectField(value, "cursor_updated_at") ?? ""),
    remoteLastEventId: idToString(objectField(value, "remote_last_event_id")),
    pendingCatchup: Boolean(objectField(value, "pending_catchup"))
  };
}

function peerStatusFromHTTP(value: unknown): PeerStatus {
  return {
    nodeId: idToString(objectField(value, "node_id")),
    configuredUrl: String(objectField(value, "configured_url") ?? ""),
    source: String(objectField(value, "source") ?? ""),
    discoveredUrl: String(objectField(value, "discovered_url") ?? ""),
    discoveryState: String(objectField(value, "discovery_state") ?? ""),
    lastDiscoveredAt: String(objectField(value, "last_discovered_at") ?? ""),
    lastConnectedAt: String(objectField(value, "last_connected_at") ?? ""),
    lastDiscoveryError: String(objectField(value, "last_discovery_error") ?? ""),
    connected: Boolean(objectField(value, "connected")),
    sessionDirection: String(objectField(value, "session_direction") ?? ""),
    origins: itemsField(objectField(value, "origins"), []).map(peerOriginStatusFromHTTP),
    pendingSnapshotPartitions: numberField(objectField(value, "pending_snapshot_partitions")),
    remoteSnapshotVersion: String(objectField(value, "remote_snapshot_version") ?? ""),
    remoteMessageWindowSize: numberField(objectField(value, "remote_message_window_size")),
    clockOffsetMs: idToString(objectField(value, "clock_offset_ms")),
    lastClockSync: String(objectField(value, "last_clock_sync") ?? ""),
    snapshotDigestsSentTotal: idToString(objectField(value, "snapshot_digests_sent_total")),
    snapshotDigestsReceivedTotal: idToString(objectField(value, "snapshot_digests_received_total")),
    snapshotChunksSentTotal: idToString(objectField(value, "snapshot_chunks_sent_total")),
    snapshotChunksReceivedTotal: idToString(objectField(value, "snapshot_chunks_received_total")),
    lastSnapshotDigestAt: String(objectField(value, "last_snapshot_digest_at") ?? ""),
    lastSnapshotChunkAt: String(objectField(value, "last_snapshot_chunk_at") ?? "")
  };
}

function deleteUserResultFromHTTP(value: unknown): DeleteUserResult {
  const user = objectField(value, "user");
  return {
    status: String(objectField(value, "status") ?? ""),
    user: user == null
      ? {
          nodeId: idToString(objectField(value, "node_id")),
          userId: idToString(objectField(value, "user_id") ?? objectField(value, "id"))
        }
      : {
          nodeId: idToString(objectField(user, "node_id")),
          userId: idToString(objectField(user, "user_id") ?? objectField(user, "id"))
        }
  };
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

function attachmentTypeFromHTTP(value: unknown): AttachmentType {
  switch (String(value ?? "")) {
    case AttachmentType.ChannelManager:
      return AttachmentType.ChannelManager;
    case AttachmentType.ChannelWriter:
      return AttachmentType.ChannelWriter;
    case AttachmentType.ChannelSubscription:
      return AttachmentType.ChannelSubscription;
    case AttachmentType.UserBlacklist:
      return AttachmentType.UserBlacklist;
    default:
      throw new ProtocolError(`unsupported attachment type ${JSON.stringify(value)}`);
  }
}

function jsonValueToBytes(value: unknown, emptyObjectFallback = false): Uint8Array {
  if (value == null) {
    return emptyObjectFallback ? utf8ToBytes("{}") : new Uint8Array(0);
  }
  return utf8ToBytes(stringifyJson(value));
}

function messageBodyFromHTTP(value: unknown): Uint8Array {
  return binaryBodyFromHTTP(value, "invalid base64 body");
}

function binaryBodyFromHTTP(value: unknown, errorMessage = "invalid base64 payload"): Uint8Array {
  if (value == null) {
    return new Uint8Array(0);
  }
  if (typeof value === "string") {
    return base64ToBytes(value);
  }
  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
  }
  if (Array.isArray(value)) {
    return Uint8Array.from(value.map((item) => numberField(item)));
  }
  throw new ProtocolError(errorMessage);
}

function numberField(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return 0;
}
