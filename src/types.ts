import type { PasswordInput } from "./password";

/**
 * 消息投递模式常量。
 * - Unspecified: 未指定（空字符串）
 * - BestEffort: 尽最大努力投递，不保证可达
 * - RouteRetry: 路由重试模式，保证至少一次投递
 */
export const DeliveryMode = {
  Unspecified: "",
  BestEffort: "best_effort",
  RouteRetry: "route_retry"
} as const;

/**
 * 消息投递模式类型。
 * 可选值：""（未指定）、"best_effort"（尽最大努力）、"route_retry"（路由重试）。
 */
export type DeliveryMode = (typeof DeliveryMode)[keyof typeof DeliveryMode];

/**
 * 用户凭据（通过 nodeId + userId 方式认证）。
 * 与 {@link LoginNameCredentials} 互斥，通过联合类型 {@link Credentials} 使用。
 */
export interface UserCredentials {
  /** 用户所属节点的 ID */
  nodeId: string;
  /** 用户 ID */
  userId: string;
  /** 密码输入对象 */
  password: PasswordInput;
}

/**
 * 登录名凭据（通过 loginName 方式认证）。
 * 与 {@link UserCredentials} 互斥，通过联合类型 {@link Credentials} 使用。
 */
export interface LoginNameCredentials {
  /** 登录名 */
  loginName: string;
  /** 密码输入对象 */
  password: PasswordInput;
}

/**
 * 认证凭据联合类型。
 * 可以是 {@link UserCredentials}（通过 nodeId + userId）或 {@link LoginNameCredentials}（通过 loginName）。
 */
export type Credentials = UserCredentials | LoginNameCredentials;

/**
 * 用户引用。
 * 通过 nodeId 和 userId 唯一标识一个用户。
 */
export interface UserRef {
  /** 用户所属节点的 ID（十进制数字字符串） */
  nodeId: string;
  /** 用户 ID（十进制数字字符串） */
  userId: string;
}

/**
 * 会话引用。
 * 通过 servingNodeId 和 sessionId 唯一标识一个 WebSocket 会话。
 */
export interface SessionRef {
  /** 提供服务的节点 ID（十进制数字字符串） */
  servingNodeId: string;
  /** 会话 ID */
  sessionId: string;
}

/**
 * 消息游标。
 * 用于标识消息在节点中的位置，在断线重连时用于同步已见消息。
 */
export interface MessageCursor {
  /** 消息所在节点的 ID */
  nodeId: string;
  /** 消息序列号（十进制数字字符串） */
  seq: string;
}

/**
 * 用户对象。
 * 包含用户的基本信息、角色、配置文件等。
 */
export interface User {
  /** 用户所属节点的 ID */
  nodeId: string;
  /** 用户 ID */
  userId: string;
  /** 用户名 */
  username: string;
  /** 登录名 */
  loginName: string;
  /** 用户角色（如 "user"、"channel"、"admin" 等） */
  role: string;
  /** 用户配置文件的 JSON 字节数据 */
  profileJson: Uint8Array;
  /** 是否为系统保留用户 */
  systemReserved: boolean;
  /** 创建时间 */
  createdAt: string;
  /** 最后更新时间 */
  updatedAt: string;
  /** 来源节点 ID */
  originNodeId: string;
}

/**
 * 消息对象。
 * 包含消息的发送者、接收者、内容和时间戳。
 */
export interface Message {
  /** 消息接收者引用 */
  recipient: UserRef;
  /** 消息所在节点的 ID */
  nodeId: string;
  /** 消息序列号 */
  seq: string;
  /** 消息发送者引用 */
  sender: UserRef;
  /** 消息体（字节数据） */
  body: Uint8Array;
  /** 消息创建时间的混合逻辑时钟（HLC）时间戳 */
  createdAtHlc: string;
}

/**
 * 数据包对象。
 * 表示需要通过中继传输的消息包，支持不同的投递模式。
 */
export interface Packet {
  /** 数据包 ID */
  packetId: string;
  /** 源节点 ID */
  sourceNodeId: string;
  /** 目标节点 ID */
  targetNodeId: string;
  /** 接收者用户引用 */
  recipient: UserRef;
  /** 发送者用户引用 */
  sender: UserRef;
  /** 数据包体（字节数据） */
  body: Uint8Array;
  /** 投递模式 */
  deliveryMode: DeliveryMode;
  /** 可选的目标会话引用 */
  targetSession?: SessionRef;
}

/**
 * 中继确认对象。
 * 当数据包被服务器接受并准备转发时返回，表示中继请求已被接收。
 */
export interface RelayAccepted {
  /** 数据包 ID */
  packetId: string;
  /** 源节点 ID */
  sourceNodeId: string;
  /** 目标节点 ID */
  targetNodeId: string;
  /** 接收者用户引用 */
  recipient: UserRef;
  /** 投递模式 */
  deliveryMode: DeliveryMode;
  /** 可选的目标会话引用 */
  targetSession?: SessionRef;
}

/**
 * 附件类型常量。
 * 定义用户之间的关联关系类型：
 * - ChannelManager: 频道管理员
 * - ChannelWriter: 频道写入者
 * - ChannelSubscription: 频道订阅
 * - UserBlacklist: 用户黑名单
 */
export const AttachmentType = {
  ChannelManager: "channel_manager",
  ChannelWriter: "channel_writer",
  ChannelSubscription: "channel_subscription",
  UserBlacklist: "user_blacklist"
} as const;

/**
 * 附件类型。
 * 可选值： "channel_manager"、"channel_writer"、"channel_subscription"、"user_blacklist"。
 */
export type AttachmentType = (typeof AttachmentType)[keyof typeof AttachmentType];

/**
 * 附件对象。
 * 表示用户之间的关联关系，如频道订阅、频道管理员、黑名单等。
 */
export interface Attachment {
  /** 附件所有者（关系主体） */
  owner: UserRef;
  /** 附件目标（关系客体） */
  subject: UserRef;
  /** 附件类型 */
  attachmentType: AttachmentType;
  /** 附件配置的 JSON 字节数据 */
  configJson: Uint8Array;
  /** 创建时间 */
  attachedAt: string;
  /** 删除时间（空字符串表示未删除） */
  deletedAt: string;
  /** 来源节点 ID */
  originNodeId: string;
}

/**
 * 订阅关系对象。
 * 记录用户对频道的订阅关系。
 */
export interface Subscription {
  /** 订阅者用户引用 */
  subscriber: UserRef;
  /** 频道用户引用 */
  channel: UserRef;
  /** 订阅时间 */
  subscribedAt: string;
  /** 取消订阅时间（空字符串表示仍有效） */
  deletedAt: string;
  /** 来源节点 ID */
  originNodeId: string;
}

/**
 * 黑名单条目对象。
 * 记录用户将其他用户加入黑名单的关系。
 */
export interface BlacklistEntry {
  /** 黑名单所有者（执行拉黑操作的用户） */
  owner: UserRef;
  /** 被屏蔽的用户引用 */
  blocked: UserRef;
  /** 拉黑时间 */
  blockedAt: string;
  /** 解除屏蔽时间（空字符串表示仍有效） */
  deletedAt: string;
  /** 来源节点 ID */
  originNodeId: string;
}

/**
 * 用户元数据条目。
 * 为用户存储键值对形式的元数据，支持过期时间。
 */
export interface UserMetadata {
  /** 元数据所有者的用户引用 */
  owner: UserRef;
  /** 元数据键名 */
  key: string;
  /** 元数据值（字节数据） */
  value: Uint8Array;
  /** 最后更新时间 */
  updatedAt: string;
  /** 删除时间（空字符串表示未删除） */
  deletedAt: string;
  /** 过期时间（空字符串表示不过期） */
  expiresAt: string;
  /** 来源节点 ID */
  originNodeId: string;
}

/**
 * 事件对象。
 * 表示集群中的领域事件，遵循事件溯源模式。
 */
export interface Event {
  /** 事件序列号 */
  sequence: string;
  /** 事件 ID */
  eventId: string;
  /** 事件类型 */
  eventType: string;
  /** 聚合类型 */
  aggregate: string;
  /** 聚合所属节点 ID */
  aggregateNodeId: string;
  /** 聚合 ID */
  aggregateId: string;
  /** 混合逻辑时钟（HLC）时间戳 */
  hlc: string;
  /** 来源节点 ID */
  originNodeId: string;
  /** 事件数据的 JSON 字节 */
  eventJson: Uint8Array;
}

/**
 * 集群节点对象。
 * 描述集群中的一个节点及其连接信息。
 */
export interface ClusterNode {
  /** 节点 ID */
  nodeId: string;
  /** 是否为本地节点 */
  isLocal: boolean;
  /** 配置的 URL 地址 */
  configuredUrl: string;
  /** 节点来源（如 "config"、"discovery" 等） */
  source: string;
}

/**
 * 已登录用户信息。
 * 描述当前在某个节点上已登录的用户简要信息。
 */
export interface LoggedInUser {
  /** 用户所属节点 ID */
  nodeId: string;
  /** 用户 ID */
  userId: string;
  /** 用户名 */
  username: string;
  /** 登录名 */
  loginName: string;
}

/**
 * 在线节点状态。
 * 描述用户在当前节点上的在线状态和会话数量。
 */
export interface OnlineNodePresence {
  /** 提供服务的节点 ID */
  servingNodeId: string;
  /** 该节点上的会话数量 */
  sessionCount: number;
  /** 传输方式提示（如 "ws"、"wss" 等） */
  transportHint: string;
}

/**
 * 已解析的会话信息。
 * 通过 {@link ResolveUserSessionsResult} 获得用户具体的会话信息。
 */
export interface ResolvedSession {
  /** 会话引用 */
  session: SessionRef;
  /** 传输协议 */
  transport: string;
  /** 是否支持瞬时消息 */
  transientCapable: boolean;
}

/**
 * 解析用户会话的结果。
 * 包含用户引用、在线节点状态列表和已解析的会话列表。
 */
export interface ResolveUserSessionsResult {
  /** 目标用户引用 */
  user: UserRef;
  /** 在线节点状态列表 */
  presence: OnlineNodePresence[];
  /** 已解析的会话列表 */
  sessions: ResolvedSession[];
}

/**
 * 消息修剪状态。
 * 描述消息窗口自动清理旧消息的进度。
 */
export interface MessageTrimStatus {
  /** 已修剪的消息总数 */
  trimmedTotal: string;
  /** 最后一次修剪的时间 */
  lastTrimmedAt: string;
}

/**
 * 投影状态。
 * 描述事件投影的处理进度和最后失败时间。
 */
export interface ProjectionStatus {
  /** 待处理的事件总数 */
  pendingTotal: string;
  /** 最后一次投影失败的时间 */
  lastFailedAt: string;
}

/**
 * 对等节点的源状态。
 * 描述集群中对等节点之间特定数据源的事件同步状态。
 */
export interface PeerOriginStatus {
  /** 数据源的节点 ID */
  originNodeId: string;
  /** 已确认的最新事件 ID */
  ackedEventId: string;
  /** 已应用的最新事件 ID */
  appliedEventId: string;
  /** 未确认的事件数量 */
  unconfirmedEvents: string;
  /** 游标更新时间 */
  cursorUpdatedAt: string;
  /** 对端的最新事件 ID */
  remoteLastEventId: string;
  /** 是否正在追赶同步 */
  pendingCatchup: boolean;
}

/**
 * 对等节点状态。
 * 描述集群中当前节点与另一个对等节点之间连接的详细状态信息。
 */
export interface PeerStatus {
  /** 对等节点 ID */
  nodeId: string;
  /** 配置的 URL */
  configuredUrl: string;
  /** 节点来源 */
  source: string;
  /** 自动发现的 URL */
  discoveredUrl: string;
  /** 发现状态 */
  discoveryState: string;
  /** 最后发现时间 */
  lastDiscoveredAt: string;
  /** 最后连接时间 */
  lastConnectedAt: string;
  /** 最后发现错误 */
  lastDiscoveryError: string;
  /** 是否已连接 */
  connected: boolean;
  /** 会话方向 */
  sessionDirection: string;
  /** 各数据源的同步状态 */
  origins: PeerOriginStatus[];
  /** 待处理的快照分区数 */
  pendingSnapshotPartitions: number;
  /** 对端快照版本 */
  remoteSnapshotVersion: string;
  /** 对端消息窗口大小 */
  remoteMessageWindowSize: number;
  /** 时钟偏移量（毫秒） */
  clockOffsetMs: string;
  /** 最后时钟同步时间 */
  lastClockSync: string;
  /** 发送的快照摘要总数 */
  snapshotDigestsSentTotal: string;
  /** 接收的快照摘要总数 */
  snapshotDigestsReceivedTotal: string;
  /** 发送的快照块总数 */
  snapshotChunksSentTotal: string;
  /** 接收的快照块总数 */
  snapshotChunksReceivedTotal: string;
  /** 最后快照摘要传输时间 */
  lastSnapshotDigestAt: string;
  /** 最后快照块传输时间 */
  lastSnapshotChunkAt: string;
}

/**
 * 节点操作状态。
 * 描述节点的整体运行状态，包括消息窗口、事件、冲突和对等连接。
 */
export interface OperationsStatus {
  /** 节点 ID */
  nodeId: string;
  /** 消息窗口大小 */
  messageWindowSize: number;
  /** 最后事件序列号 */
  lastEventSequence: string;
  /** 写入门是否就绪 */
  writeGateReady: boolean;
  /** 冲突事件总数 */
  conflictTotal: string;
  /** 消息修剪状态 */
  messageTrim: MessageTrimStatus;
  /** 投影状态 */
  projection: ProjectionStatus;
  /** 对等节点状态列表 */
  peers: PeerStatus[];
}

/**
 * 删除用户操作的结果。
 */
export interface DeleteUserResult {
  /** 操作状态 */
  status: string;
  /** 被删除的用户引用 */
  user: UserRef;
}

/**
 * 登录成功后的信息。
 * 包含用户信息、协议版本和当前会话引用。
 */
export interface LoginInfo {
  /** 完整的用户信息 */
  user: User;
  /** 协议版本号 */
  protocolVersion: string;
  /** 当前会话引用 */
  sessionRef: SessionRef;
}

/**
 * 发送消息的输入参数。
 */
export interface SendMessageInput {
  /** 目标用户引用 */
  target: UserRef;
  /** 消息体（字节数据） */
  body: Uint8Array;
}

/**
 * 发送数据包的输入参数。
 */
export interface SendPacketInput {
  /** 目标用户引用 */
  target: UserRef;
  /** 数据包体（字节数据） */
  body: Uint8Array;
  /** 投递模式 */
  deliveryMode: DeliveryMode;
  /** 可选的目标会话引用 */
  targetSession?: SessionRef;
}

/**
 * 创建用户的请求参数。
 */
export interface CreateUserRequest {
  /** 用户名 */
  username: string;
  /** 可选的密码输入对象 */
  password?: PasswordInput;
  /** 可选的配置文件 JSON 字节数据 */
  profileJson?: Uint8Array;
  /** 用户角色（如 "user"、"channel"、"admin" 等） */
  role: string;
  /** 可选的登录名 */
  loginName?: string;
}

/**
 * 更新用户的请求参数。
 * 所有字段均为可选，仅更新提供的字段。
 */
export interface UpdateUserRequest {
  /** 新的用户名 */
  username?: string;
  /** 新的密码输入对象 */
  password?: PasswordInput;
  /** 新的配置文件 JSON 字节数据 */
  profileJson?: Uint8Array;
  /** 新的角色 */
  role?: string;
  /** 新的登录名 */
  loginName?: string;
}

/**
 * 插入或更新用户元数据的请求参数。
 */
export interface UpsertUserMetadataRequest {
  /** 元数据值（字节数据） */
  value: Uint8Array;
  /** 可选的过期时间 */
  expiresAt?: string;
}

/**
 * 扫描用户元数据的请求参数。
 * 支持按前缀过滤和分页查询。
 */
export interface ScanUserMetadataRequest {
  /** 可选的前缀过滤条件 */
  prefix?: string;
  /** 分页游标，从指定位置开始查询 */
  after?: string;
  /** 返回结果的最大数量（不超过 1000） */
  limit?: number;
}

/**
 * 扫描用户元数据的结果。
 */
export interface ScanUserMetadataResult {
  /** 元数据条目列表 */
  items: UserMetadata[];
  /** 返回的条目数量 */
  count: number;
  /** 下一页游标，用于继续扫描（空表示没有更多数据） */
  nextAfter: string;
}

/**
 * 请求选项。
 * 用于控制请求的超时和取消行为。
 */
export interface RequestOptions {
  /** 可选的 AbortSignal，用于取消请求 */
  signal?: AbortSignal;
  /** 可选的超时时间（毫秒） */
  timeoutMs?: number;
}

/**
 * 发送数据包的选项。
 * 继承自 {@link RequestOptions}，额外支持指定目标会话。
 */
export interface SendPacketOptions extends RequestOptions {
  /** 可选的目标会话引用 */
  targetSession?: SessionRef;
}
