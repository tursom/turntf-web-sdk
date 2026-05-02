import {
  AttachmentType as ProtoAttachmentType,
  type Attachment as ProtoAttachment,
  ClientDeliveryMode,
  type ClusterNode as ProtoClusterNode,
  type Event as ProtoEvent,
  type LoggedInUser as ProtoLoggedInUser,
  type Message as ProtoMessage,
  type MessageCursor as ProtoMessageCursor,
  type OnlineNodePresence as ProtoOnlineNodePresence,
  type OperationsStatus as ProtoOperationsStatus,
  type Packet as ProtoPacket,
  type PeerOriginStatus as ProtoPeerOriginStatus,
  type PeerStatus as ProtoPeerStatus,
  type ProjectionStatus as ProtoProjectionStatus,
  type ResolveUserSessionsResponse as ProtoResolveUserSessionsResponse,
  type ScanUserMetadataResponse as ProtoScanUserMetadataResponse,
  type ResolvedSession as ProtoResolvedSession,
  type SessionRef as ProtoSessionRef,
  type TransientAccepted as ProtoTransientAccepted,
  type User as ProtoUser,
  type UserMetadata as ProtoUserMetadata,
  type UserRef as ProtoUserRef
} from "./generated/client";
import { ProtocolError } from "./errors";
import {
  AttachmentType,
  type Attachment,
  DeliveryMode,
  type BlacklistEntry,
  type ClusterNode,
  type Event,
  type LoggedInUser,
  type Message,
  type MessageCursor,
  type MessageTrimStatus,
  type OnlineNodePresence,
  type OperationsStatus,
  type Packet,
  type PeerOriginStatus,
  type PeerStatus,
  type ProjectionStatus,
  type ResolveUserSessionsResult,
  type RelayAccepted,
  type ResolvedSession,
  type ScanUserMetadataResult,
  type SessionRef,
  type Subscription,
  type User,
  type UserMetadata,
  type UserRef
} from "./types";
import { cloneBytes } from "./utils";

const zeroUserRef: UserRef = { nodeId: "0", userId: "0" };

/**
 * 将 SDK 的 UserRef 转换为 protobuf 的 ProtoUserRef。
 *
 * @param ref - SDK 用户引用对象
 * @returns protobuf 用户引用对象
 */
export function userRefToProto(ref: UserRef): ProtoUserRef {
  return { nodeId: ref.nodeId, userId: ref.userId };
}

/**
 * 将 SDK 的 SessionRef 转换为 protobuf 的 ProtoSessionRef。
 *
 * @param ref - SDK 会话引用对象
 * @returns protobuf 会话引用对象
 */
export function sessionRefToProto(ref: SessionRef): ProtoSessionRef {
  return { servingNodeId: ref.servingNodeId, sessionId: ref.sessionId };
}

/**
 * 将 SDK 的 MessageCursor 转换为 protobuf 的 ProtoMessageCursor。
 *
 * @param cursor - SDK 消息游标
 * @returns protobuf 消息游标
 */
export function cursorToProto(cursor: MessageCursor): ProtoMessageCursor {
  return { nodeId: cursor.nodeId, seq: cursor.seq };
}

/**
 * 将 protobuf 的 ProtoMessageCursor 转换为 SDK 的 MessageCursor。
 * 如果传入 undefined，返回默认游标（nodeId 和 seq 均为 "0"）。
 *
 * @param cursor - protobuf 消息游标（可选）
 * @returns SDK 消息游标
 */
export function cursorFromProto(cursor: ProtoMessageCursor | undefined): MessageCursor {
  return { nodeId: cursor?.nodeId ?? "0", seq: cursor?.seq ?? "0" };
}

/**
 * 将 protobuf 的 ProtoUserRef 转换为 SDK 的 UserRef。
 * 如果传入 undefined，返回默认零值引用（nodeId 和 userId 均为 "0"）。
 *
 * @param ref - protobuf 用户引用（可选）
 * @returns SDK 用户引用对象
 */
export function userRefFromProto(ref: ProtoUserRef | undefined): UserRef {
  return ref == null ? { ...zeroUserRef } : { nodeId: ref.nodeId, userId: ref.userId };
}

/**
 * 将 protobuf 的 ProtoSessionRef 转换为 SDK 的 SessionRef。
 * 如果传入 undefined，抛出 ProtocolError。
 *
 * @param ref - protobuf 会话引用（可选）
 * @returns SDK 会话引用对象
 * @throws {@link ProtocolError} 如果传入 undefined
 */
export function sessionRefFromProto(ref: ProtoSessionRef | undefined): SessionRef {
  if (ref == null) {
    throw new ProtocolError("missing session_ref");
  }
  return { servingNodeId: ref.servingNodeId, sessionId: ref.sessionId };
}

/**
 * 将 protobuf 的 ProtoSessionRef 可选地转换为 SDK 的 SessionRef。
 * 与 {@link sessionRefFromProto} 不同，传入 undefined 时返回 undefined 而非抛出错误。
 *
 * @param ref - protobuf 会话引用（可选）
 * @returns SDK 会话引用对象，如果未提供则返回 undefined
 */
export function optionalSessionRefFromProto(ref: ProtoSessionRef | undefined): SessionRef | undefined {
  if (ref == null) {
    return undefined;
  }
  return { servingNodeId: ref.servingNodeId, sessionId: ref.sessionId };
}

/**
 * 将 protobuf 的 ProtoUser 转换为 SDK 的 User 对象。
 *
 * @param user - protobuf 用户对象（可选）
 * @returns SDK 用户对象
 * @throws {@link ProtocolError} 如果传入 undefined
 */
export function userFromProto(user: ProtoUser | undefined): User {
  if (user == null) {
    throw new ProtocolError("missing user");
  }
  return {
    nodeId: user.nodeId,
    userId: user.userId,
    username: user.username,
    loginName: user.loginName,
    role: user.role,
    profileJson: cloneBytes(user.profileJson),
    systemReserved: user.systemReserved,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    originNodeId: user.originNodeId
  };
}

/**
 * 将 protobuf 的 ProtoMessage 转换为 SDK 的 Message 对象。
 *
 * @param message - protobuf 消息对象（可选）
 * @returns SDK 消息对象
 * @throws {@link ProtocolError} 如果传入 undefined
 */
export function messageFromProto(message: ProtoMessage | undefined): Message {
  if (message == null) {
    throw new ProtocolError("missing message");
  }
  return {
    recipient: userRefFromProto(message.recipient),
    nodeId: message.nodeId,
    seq: message.seq,
    sender: userRefFromProto(message.sender),
    body: cloneBytes(message.body),
    createdAtHlc: message.createdAtHlc
  };
}

/**
 * 将 protobuf 的 ProtoPacket 转换为 SDK 的 Packet 对象。
 *
 * @param packet - protobuf 数据包对象（可选）
 * @returns SDK 数据包对象
 * @throws {@link ProtocolError} 如果传入 undefined
 */
export function packetFromProto(packet: ProtoPacket | undefined): Packet {
  if (packet == null) {
    throw new ProtocolError("missing packet");
  }
  const mapped: Packet = {
    packetId: packet.packetId,
    sourceNodeId: packet.sourceNodeId,
    targetNodeId: packet.targetNodeId,
    recipient: userRefFromProto(packet.recipient),
    sender: userRefFromProto(packet.sender),
    body: cloneBytes(packet.body),
    deliveryMode: deliveryModeFromProto(packet.deliveryMode)
  };
  const targetSession = optionalSessionRefFromProto(packet.targetSession);
  if (targetSession != null) {
    mapped.targetSession = targetSession;
  }
  return mapped;
}

/**
 * 将 protobuf 的 ProtoTransientAccepted 转换为 SDK 的 RelayAccepted 对象。
 *
 * @param accepted - protobuf 中继确认对象（可选）
 * @returns SDK 中继确认对象
 * @throws {@link ProtocolError} 如果传入 undefined
 */
export function relayAcceptedFromProto(accepted: ProtoTransientAccepted | undefined): RelayAccepted {
  if (accepted == null) {
    throw new ProtocolError("missing transient_accepted");
  }
  const mapped: RelayAccepted = {
    packetId: accepted.packetId,
    sourceNodeId: accepted.sourceNodeId,
    targetNodeId: accepted.targetNodeId,
    recipient: userRefFromProto(accepted.recipient),
    deliveryMode: deliveryModeFromProto(accepted.deliveryMode)
  };
  const targetSession = optionalSessionRefFromProto(accepted.targetSession);
  if (targetSession != null) {
    mapped.targetSession = targetSession;
  }
  return mapped;
}

function attachmentTypeFromProto(type: ProtoAttachmentType): AttachmentType {
  switch (type) {
    case ProtoAttachmentType.CHANNEL_MANAGER:
      return AttachmentType.ChannelManager;
    case ProtoAttachmentType.CHANNEL_WRITER:
      return AttachmentType.ChannelWriter;
    case ProtoAttachmentType.CHANNEL_SUBSCRIPTION:
      return AttachmentType.ChannelSubscription;
    case ProtoAttachmentType.USER_BLACKLIST:
      return AttachmentType.UserBlacklist;
    default:
      throw new ProtocolError(`unsupported attachment type ${ProtoAttachmentType[type] ?? type}`);
  }
}

/**
 * 将 SDK 的 AttachmentType 转换为 protobuf 的 ProtoAttachmentType。
 *
 * @param type - SDK 附件类型
 * @returns protobuf 附件类型
 */
export function attachmentTypeToProto(type: AttachmentType): ProtoAttachmentType {
  switch (type) {
    case AttachmentType.ChannelManager:
      return ProtoAttachmentType.CHANNEL_MANAGER;
    case AttachmentType.ChannelWriter:
      return ProtoAttachmentType.CHANNEL_WRITER;
    case AttachmentType.ChannelSubscription:
      return ProtoAttachmentType.CHANNEL_SUBSCRIPTION;
    case AttachmentType.UserBlacklist:
      return ProtoAttachmentType.USER_BLACKLIST;
    default:
      return ProtoAttachmentType.UNSPECIFIED;
  }
}

/**
 * 将 protobuf 的 ProtoAttachment 转换为 SDK 的 Attachment 对象。
 *
 * @param attachment - protobuf 附件对象（可选）
 * @returns SDK 附件对象
 * @throws {@link ProtocolError} 如果传入 undefined
 */
export function attachmentFromProto(attachment: ProtoAttachment | undefined): Attachment {
  if (attachment == null) {
    throw new ProtocolError("missing attachment");
  }
  return {
    owner: userRefFromProto(attachment.owner),
    subject: userRefFromProto(attachment.subject),
    attachmentType: attachmentTypeFromProto(attachment.attachmentType),
    configJson: cloneBytes(attachment.configJson),
    attachedAt: attachment.attachedAt,
    deletedAt: attachment.deletedAt,
    originNodeId: attachment.originNodeId
  };
}

/**
 * 将 protobuf 的 ProtoAttachment 转换为 SDK 的 Subscription 对象。
 * ProtoAttachment 的 owner 映射为 subscriber，subject 映射为 channel。
 *
 * @param subscription - protobuf 附件对象（可选）
 * @returns SDK 订阅对象
 * @throws {@link ProtocolError} 如果传入 undefined
 */
export function subscriptionFromProto(subscription: ProtoAttachment | undefined): Subscription {
  const attachment = attachmentFromProto(subscription);
  return {
    subscriber: attachment.owner,
    channel: attachment.subject,
    subscribedAt: attachment.attachedAt,
    deletedAt: attachment.deletedAt,
    originNodeId: attachment.originNodeId
  };
}

/**
 * 将 protobuf 的 ProtoAttachment 转换为 SDK 的 BlacklistEntry 对象。
 * ProtoAttachment 的 owner 映射为 blacklist 的 owner，subject 映射为 blocked。
 *
 * @param entry - protobuf 附件对象（可选）
 * @returns SDK 黑名单条目对象
 * @throws {@link ProtocolError} 如果传入 undefined
 */
export function blacklistEntryFromProto(entry: ProtoAttachment | undefined): BlacklistEntry {
  const attachment = attachmentFromProto(entry);
  return {
    owner: attachment.owner,
    blocked: attachment.subject,
    blockedAt: attachment.attachedAt,
    deletedAt: attachment.deletedAt,
    originNodeId: attachment.originNodeId
  };
}

/**
 * 将 protobuf 的 ProtoUserMetadata 转换为 SDK 的 UserMetadata 对象。
 *
 * @param metadata - protobuf 用户元数据对象（可选）
 * @returns SDK 用户元数据对象
 * @throws {@link ProtocolError} 如果传入 undefined
 */
export function userMetadataFromProto(metadata: ProtoUserMetadata | undefined): UserMetadata {
  if (metadata == null) {
    throw new ProtocolError("missing user metadata");
  }
  return {
    owner: userRefFromProto(metadata.owner),
    key: metadata.key,
    value: cloneBytes(metadata.value),
    updatedAt: metadata.updatedAt,
    deletedAt: metadata.deletedAt,
    expiresAt: metadata.expiresAt,
    originNodeId: metadata.originNodeId
  };
}

/**
 * 将 protobuf 的 ProtoScanUserMetadataResponse 转换为 SDK 的 ScanUserMetadataResult。
 *
 * @param response - protobuf 扫描元数据响应（可选）
 * @returns SDK 扫描元数据结果
 * @throws {@link ProtocolError} 如果传入 undefined
 */
export function scanUserMetadataResultFromProto(
  response: ProtoScanUserMetadataResponse | undefined
): ScanUserMetadataResult {
  if (response == null) {
    throw new ProtocolError("missing scan_user_metadata_response");
  }
  return {
    items: response.items.map(userMetadataFromProto),
    count: response.count,
    nextAfter: response.nextAfter
  };
}

/**
 * 将 protobuf 的 ProtoEvent 转换为 SDK 的 Event 对象。
 *
 * @param event - protobuf 事件对象（可选）
 * @returns SDK 事件对象
 * @throws {@link ProtocolError} 如果传入 undefined
 */
export function eventFromProto(event: ProtoEvent | undefined): Event {
  if (event == null) {
    throw new ProtocolError("missing event");
  }
  return {
    sequence: event.sequence,
    eventId: event.eventId,
    eventType: event.eventType,
    aggregate: event.aggregate,
    aggregateNodeId: event.aggregateNodeId,
    aggregateId: event.aggregateId,
    hlc: event.hlc,
    originNodeId: event.originNodeId,
    eventJson: cloneBytes(event.eventJson)
  };
}

/**
 * 将 protobuf 的 ProtoClusterNode 转换为 SDK 的 ClusterNode 对象。
 *
 * @param node - protobuf 集群节点对象（可选）
 * @returns SDK 集群节点对象
 * @throws {@link ProtocolError} 如果传入 undefined
 */
export function clusterNodeFromProto(node: ProtoClusterNode | undefined): ClusterNode {
  if (node == null) {
    throw new ProtocolError("missing cluster node");
  }
  return {
    nodeId: node.nodeId,
    isLocal: node.isLocal,
    configuredUrl: node.configuredUrl,
    source: node.source
  };
}

/**
 * 将 protobuf 的 ProtoLoggedInUser 转换为 SDK 的 LoggedInUser 对象。
 *
 * @param user - protobuf 已登录用户对象（可选）
 * @returns SDK 已登录用户对象
 * @throws {@link ProtocolError} 如果传入 undefined
 */
export function loggedInUserFromProto(user: ProtoLoggedInUser | undefined): LoggedInUser {
  if (user == null) {
    throw new ProtocolError("missing logged-in user");
  }
  return {
    nodeId: user.nodeId,
    userId: user.userId,
    username: user.username,
    loginName: user.loginName
  };
}

/**
 * 将 protobuf 的 ProtoOnlineNodePresence 转换为 SDK 的 OnlineNodePresence 对象。
 *
 * @param item - protobuf 在线节点状态对象（可选）
 * @returns SDK 在线节点状态对象
 * @throws {@link ProtocolError} 如果传入 undefined
 */
export function onlineNodePresenceFromProto(item: ProtoOnlineNodePresence | undefined): OnlineNodePresence {
  if (item == null) {
    throw new ProtocolError("missing online node presence");
  }
  return {
    servingNodeId: item.servingNodeId,
    sessionCount: item.sessionCount,
    transportHint: item.transportHint
  };
}

/**
 * 将 protobuf 的 ProtoResolvedSession 转换为 SDK 的 ResolvedSession 对象。
 *
 * @param item - protobuf 已解析会话对象（可选）
 * @returns SDK 已解析会话对象
 * @throws {@link ProtocolError} 如果传入 undefined
 */
export function resolvedSessionFromProto(item: ProtoResolvedSession | undefined): ResolvedSession {
  if (item == null) {
    throw new ProtocolError("missing resolved session");
  }
  return {
    session: sessionRefFromProto(item.session),
    transport: item.transport,
    transientCapable: item.transientCapable
  };
}

/**
 * 将 protobuf 的 ProtoResolveUserSessionsResponse 转换为 SDK 的 ResolveUserSessionsResult。
 *
 * @param response - protobuf 解析用户会话响应（可选）
 * @returns SDK 解析用户会话结果
 * @throws {@link ProtocolError} 如果传入 undefined
 */
export function resolveUserSessionsFromProto(
  response: ProtoResolveUserSessionsResponse | undefined
): ResolveUserSessionsResult {
  if (response == null) {
    throw new ProtocolError("missing resolve_user_sessions_response");
  }
  return {
    user: userRefFromProto(response.user),
    presence: response.presence.map(onlineNodePresenceFromProto),
    sessions: response.items.map(resolvedSessionFromProto)
  };
}

/**
 * 将 protobuf 的 ProtoOperationsStatus 转换为 SDK 的 OperationsStatus 对象。
 *
 * @param status - protobuf 操作状态对象（可选）
 * @returns SDK 操作状态对象
 * @throws {@link ProtocolError} 如果传入 undefined
 */
export function operationsStatusFromProto(status: ProtoOperationsStatus | undefined): OperationsStatus {
  if (status == null) {
    throw new ProtocolError("missing operations status");
  }
  return {
    nodeId: status.nodeId,
    messageWindowSize: status.messageWindowSize,
    lastEventSequence: status.lastEventSequence,
    writeGateReady: status.writeGateReady,
    conflictTotal: status.conflictTotal,
    messageTrim: messageTrimStatusFromProto(status.messageTrim),
    projection: projectionStatusFromProto(status.projection),
    peers: status.peers.map(peerStatusFromProto)
  };
}

function messageTrimStatusFromProto(status: ProtoOperationsStatus["messageTrim"]): MessageTrimStatus {
  return {
    trimmedTotal: status?.trimmedTotal ?? "0",
    lastTrimmedAt: status?.lastTrimmedAt ?? ""
  };
}

function projectionStatusFromProto(status: ProtoProjectionStatus | undefined): ProjectionStatus {
  return {
    pendingTotal: status?.pendingTotal ?? "0",
    lastFailedAt: status?.lastFailedAt ?? ""
  };
}

function peerOriginStatusFromProto(status: ProtoPeerOriginStatus): PeerOriginStatus {
  return {
    originNodeId: status.originNodeId,
    ackedEventId: status.ackedEventId,
    appliedEventId: status.appliedEventId,
    unconfirmedEvents: status.unconfirmedEvents,
    cursorUpdatedAt: status.cursorUpdatedAt,
    remoteLastEventId: status.remoteLastEventId,
    pendingCatchup: status.pendingCatchup
  };
}

function peerStatusFromProto(status: ProtoPeerStatus): PeerStatus {
  return {
    nodeId: status.nodeId,
    configuredUrl: status.configuredUrl,
    source: status.source,
    discoveredUrl: status.discoveredUrl,
    discoveryState: status.discoveryState,
    lastDiscoveredAt: status.lastDiscoveredAt,
    lastConnectedAt: status.lastConnectedAt,
    lastDiscoveryError: status.lastDiscoveryError,
    connected: status.connected,
    sessionDirection: status.sessionDirection,
    origins: status.origins.map(peerOriginStatusFromProto),
    pendingSnapshotPartitions: status.pendingSnapshotPartitions,
    remoteSnapshotVersion: status.remoteSnapshotVersion,
    remoteMessageWindowSize: status.remoteMessageWindowSize,
    clockOffsetMs: status.clockOffsetMs,
    lastClockSync: status.lastClockSync,
    snapshotDigestsSentTotal: status.snapshotDigestsSentTotal,
    snapshotDigestsReceivedTotal: status.snapshotDigestsReceivedTotal,
    snapshotChunksSentTotal: status.snapshotChunksSentTotal,
    snapshotChunksReceivedTotal: status.snapshotChunksReceivedTotal,
    lastSnapshotDigestAt: status.lastSnapshotDigestAt,
    lastSnapshotChunkAt: status.lastSnapshotChunkAt
  };
}

/**
 * 批量将 protobuf 的 ProtoMessage 数组转换为 SDK 的 Message 数组。
 *
 * @param items - protobuf 消息对象数组
 * @returns SDK 消息对象数组
 */
export function messagesFromProto(items: ProtoMessage[]): Message[] {
  return items.map(messageFromProto);
}

/**
 * 批量将 protobuf 的 ProtoAttachment 数组转换为 SDK 的 Attachment 数组。
 *
 * @param items - protobuf 附件对象数组
 * @returns SDK 附件对象数组
 */
export function attachmentsFromProto(items: ProtoAttachment[]): Attachment[] {
  return items.map(attachmentFromProto);
}

/**
 * 批量将 protobuf 的 ProtoAttachment 数组转换为 SDK 的 Subscription 数组。
 *
 * @param items - protobuf 附件对象数组
 * @returns SDK 订阅对象数组
 */
export function subscriptionsFromProto(items: ProtoAttachment[]): Subscription[] {
  return items.map(subscriptionFromProto);
}

/**
 * 批量将 protobuf 的 ProtoAttachment 数组转换为 SDK 的 BlacklistEntry 数组。
 *
 * @param items - protobuf 附件对象数组
 * @returns SDK 黑名单条目数组
 */
export function blacklistEntriesFromProto(items: ProtoAttachment[]): BlacklistEntry[] {
  return items.map(blacklistEntryFromProto);
}

/**
 * 批量将 protobuf 的 ProtoEvent 数组转换为 SDK 的 Event 数组。
 *
 * @param items - protobuf 事件对象数组
 * @returns SDK 事件对象数组
 */
export function eventsFromProto(items: ProtoEvent[]): Event[] {
  return items.map(eventFromProto);
}

/**
 * 批量将 protobuf 的 ProtoClusterNode 数组转换为 SDK 的 ClusterNode 数组。
 *
 * @param items - protobuf 集群节点对象数组
 * @returns SDK 集群节点对象数组
 */
export function clusterNodesFromProto(items: ProtoClusterNode[]): ClusterNode[] {
  return items.map(clusterNodeFromProto);
}

/**
 * 批量将 protobuf 的 ProtoLoggedInUser 数组转换为 SDK 的 LoggedInUser 数组。
 *
 * @param items - protobuf 已登录用户对象数组
 * @returns SDK 已登录用户对象数组
 */
export function loggedInUsersFromProto(items: ProtoLoggedInUser[]): LoggedInUser[] {
  return items.map(loggedInUserFromProto);
}

/**
 * 批量将 protobuf 的 ProtoOnlineNodePresence 数组转换为 SDK 的 OnlineNodePresence 数组。
 *
 * @param items - protobuf 在线节点状态对象数组
 * @returns SDK 在线节点状态对象数组
 */
export function onlineNodePresencesFromProto(items: ProtoOnlineNodePresence[]): OnlineNodePresence[] {
  return items.map(onlineNodePresenceFromProto);
}

/**
 * 批量将 protobuf 的 ProtoResolvedSession 数组转换为 SDK 的 ResolvedSession 数组。
 *
 * @param items - protobuf 已解析会话对象数组
 * @returns SDK 已解析会话对象数组
 */
export function resolvedSessionsFromProto(items: ProtoResolvedSession[]): ResolvedSession[] {
  return items.map(resolvedSessionFromProto);
}

/**
 * 将 SDK 的 DeliveryMode 转换为 protobuf 的 ClientDeliveryMode。
 *
 * @param mode - SDK 投递模式
 * @returns protobuf 投递模式
 */
export function deliveryModeToProto(mode: DeliveryMode): ClientDeliveryMode {
  switch (mode) {
    case DeliveryMode.BestEffort:
      return ClientDeliveryMode.BEST_EFFORT;
    case DeliveryMode.RouteRetry:
      return ClientDeliveryMode.ROUTE_RETRY;
    default:
      return ClientDeliveryMode.UNSPECIFIED;
  }
}

/**
 * 将 protobuf 的 ClientDeliveryMode 转换为 SDK 的 DeliveryMode。
 *
 * @param mode - protobuf 投递模式
 * @returns SDK 投递模式
 */
export function deliveryModeFromProto(mode: ClientDeliveryMode): DeliveryMode {
  switch (mode) {
    case ClientDeliveryMode.BEST_EFFORT:
      return DeliveryMode.BestEffort;
    case ClientDeliveryMode.ROUTE_RETRY:
      return DeliveryMode.RouteRetry;
    default:
      return DeliveryMode.Unspecified;
  }
}
