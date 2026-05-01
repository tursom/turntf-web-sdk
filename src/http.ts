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
  toRequiredWireInteger,
  toWireInteger,
  validateDeliveryMode,
  validateLoginName,
  validateUserMetadataKey,
  validateUserMetadataScanRequest,
  validateUserRef
} from "./validation";

export interface HTTPClientOptions {
  fetch?: typeof fetch;
}

export class HTTPClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

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

  async login(nodeId: string, userId: string, password: string, options?: RequestOptions): Promise<string> {
    return this.loginWithPassword(nodeId, userId, await plainPassword(password), options);
  }

  async loginByLoginName(loginName: string, password: string, options?: RequestOptions): Promise<string> {
    return this.loginByLoginNameWithPassword(loginName, await plainPassword(password), options);
  }

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

  createChannel(
    token: string,
    request: Omit<CreateUserRequest, "role"> & Partial<Pick<CreateUserRequest, "role">>,
    options?: RequestOptions
  ): Promise<User> {
    return this.createUser(token, { ...request, role: request.role ?? "channel" }, options);
  }

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

  subscribeChannel(token: string, subscriber: UserRef, channel: UserRef, options?: RequestOptions): Promise<Subscription> {
    return this.createSubscription(token, subscriber, channel, options);
  }

  async unsubscribeChannel(token: string, subscriber: UserRef, channel: UserRef, options?: RequestOptions): Promise<Subscription> {
    const attachment = await this.deleteAttachment(token, subscriber, channel, AttachmentType.ChannelSubscription, options);
    return subscriptionFromAttachment(attachment);
  }

  async listSubscriptions(token: string, subscriber: UserRef, options?: RequestOptions): Promise<Subscription[]> {
    const items = await this.listAttachments(token, subscriber, AttachmentType.ChannelSubscription, options);
    return items.map(subscriptionFromAttachment);
  }

  async listMessages(token: string, target: UserRef, limit = 0, options?: RequestOptions): Promise<Message[]> {
    validateUserRef(target, "target");
    validateLimit(limit, "limit");
    const query = limit > 0 ? `?limit=${encodeURIComponent(String(limit))}` : "";
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

  async listClusterNodes(token: string, options?: RequestOptions): Promise<ClusterNode[]> {
    const response = await this.doJSON("GET", "/cluster/nodes", token, undefined, [200], options);
    return itemsField(response, ["nodes", "items"]).map(clusterNodeFromHTTP);
  }

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

  async blockUser(token: string, owner: UserRef, blocked: UserRef, options?: RequestOptions): Promise<BlacklistEntry> {
    const attachment = await this.upsertAttachment(token, owner, blocked, AttachmentType.UserBlacklist, new Uint8Array(0), options);
    return blacklistEntryFromAttachment(attachment);
  }

  async unblockUser(token: string, owner: UserRef, blocked: UserRef, options?: RequestOptions): Promise<BlacklistEntry> {
    const attachment = await this.deleteAttachment(token, owner, blocked, AttachmentType.UserBlacklist, options);
    return blacklistEntryFromAttachment(attachment);
  }

  async listBlockedUsers(token: string, owner: UserRef, options?: RequestOptions): Promise<BlacklistEntry[]> {
    const items = await this.listAttachments(token, owner, AttachmentType.UserBlacklist, options);
    return items.map(blacklistEntryFromAttachment);
  }

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

  async operationsStatus(token: string, options?: RequestOptions): Promise<OperationsStatus> {
    const response = await this.doJSON("GET", "/ops/status", token, undefined, [200], options);
    return operationsStatusFromHTTP(response);
  }

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
