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
  type ResolvedSession as ProtoResolvedSession,
  type SessionRef as ProtoSessionRef,
  type TransientAccepted as ProtoTransientAccepted,
  type User as ProtoUser,
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
  type SessionRef,
  type Subscription,
  type User,
  type UserRef
} from "./types";
import { cloneBytes } from "./utils";

const zeroUserRef: UserRef = { nodeId: "0", userId: "0" };

export function userRefToProto(ref: UserRef): ProtoUserRef {
  return { nodeId: ref.nodeId, userId: ref.userId };
}

export function sessionRefToProto(ref: SessionRef): ProtoSessionRef {
  return { servingNodeId: ref.servingNodeId, sessionId: ref.sessionId };
}

export function cursorToProto(cursor: MessageCursor): ProtoMessageCursor {
  return { nodeId: cursor.nodeId, seq: cursor.seq };
}

export function cursorFromProto(cursor: ProtoMessageCursor | undefined): MessageCursor {
  return { nodeId: cursor?.nodeId ?? "0", seq: cursor?.seq ?? "0" };
}

export function userRefFromProto(ref: ProtoUserRef | undefined): UserRef {
  return ref == null ? { ...zeroUserRef } : { nodeId: ref.nodeId, userId: ref.userId };
}

export function sessionRefFromProto(ref: ProtoSessionRef | undefined): SessionRef {
  if (ref == null) {
    throw new ProtocolError("missing session_ref");
  }
  return { servingNodeId: ref.servingNodeId, sessionId: ref.sessionId };
}

export function optionalSessionRefFromProto(ref: ProtoSessionRef | undefined): SessionRef | undefined {
  if (ref == null) {
    return undefined;
  }
  return { servingNodeId: ref.servingNodeId, sessionId: ref.sessionId };
}

export function userFromProto(user: ProtoUser | undefined): User {
  if (user == null) {
    throw new ProtocolError("missing user");
  }
  return {
    nodeId: user.nodeId,
    userId: user.userId,
    username: user.username,
    role: user.role,
    profileJson: cloneBytes(user.profileJson),
    systemReserved: user.systemReserved,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    originNodeId: user.originNodeId
  };
}

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

export function loggedInUserFromProto(user: ProtoLoggedInUser | undefined): LoggedInUser {
  if (user == null) {
    throw new ProtocolError("missing logged-in user");
  }
  return {
    nodeId: user.nodeId,
    userId: user.userId,
    username: user.username
  };
}

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

export function messagesFromProto(items: ProtoMessage[]): Message[] {
  return items.map(messageFromProto);
}

export function attachmentsFromProto(items: ProtoAttachment[]): Attachment[] {
  return items.map(attachmentFromProto);
}

export function subscriptionsFromProto(items: ProtoAttachment[]): Subscription[] {
  return items.map(subscriptionFromProto);
}

export function blacklistEntriesFromProto(items: ProtoAttachment[]): BlacklistEntry[] {
  return items.map(blacklistEntryFromProto);
}

export function eventsFromProto(items: ProtoEvent[]): Event[] {
  return items.map(eventFromProto);
}

export function clusterNodesFromProto(items: ProtoClusterNode[]): ClusterNode[] {
  return items.map(clusterNodeFromProto);
}

export function loggedInUsersFromProto(items: ProtoLoggedInUser[]): LoggedInUser[] {
  return items.map(loggedInUserFromProto);
}

export function onlineNodePresencesFromProto(items: ProtoOnlineNodePresence[]): OnlineNodePresence[] {
  return items.map(onlineNodePresenceFromProto);
}

export function resolvedSessionsFromProto(items: ProtoResolvedSession[]): ResolvedSession[] {
  return items.map(resolvedSessionFromProto);
}

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
