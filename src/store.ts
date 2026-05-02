import type { Message, MessageCursor } from "./types";
import { cursorForMessage } from "./validation";

/**
 * 游标存储器接口。
 * 用于持久化已接收消息的游标信息，支持断线重连后从上次中断处恢复消息同步。
 * 实现此接口可自定义存储后端（如 localStorage、IndexedDB 等），
 * 默认使用 {@link MemoryCursorStore}（内存存储，页面刷新后丢失）。
 */
export interface CursorStore {
  /**
   * 加载所有已记录的已见消息游标。
   * 连接建立时将把这些游标发送给服务器，以避免重复接收已处理的消息。
   * @returns 消息游标数组，支持同步或异步返回
   */
  loadSeenMessages(): Promise<MessageCursor[]> | MessageCursor[];

  /**
   * 保存已接收的消息。
   * 在收到新消息时由 SDK 自动调用。
   * @param message - 接收到的消息对象
   */
  saveMessage(message: Message): Promise<void> | void;

  /**
   * 保存消息游标。
   * 在收到新消息时由 SDK 自动调用，用于记录已处理的消息位置。
   * @param cursor - 消息游标
   */
  saveCursor(cursor: MessageCursor): Promise<void> | void;
}

/**
 * 基于内存的游标存储器。
 * 消息和游标存储在内存 Map 中，页面刷新后数据会丢失。
 * 如需持久化存储，请实现 {@link CursorStore} 接口并传入 Client 选项。
 */
export class MemoryCursorStore implements CursorStore {
  private readonly messages = new Map<string, Message>();
  private readonly order: MessageCursor[] = [];

  /**
   * 加载所有已记录的已见消息游标列表。
   * @returns 消息游标数组的副本
   */
  loadSeenMessages(): MessageCursor[] {
    return this.order.map((cursor) => ({ ...cursor }));
  }

  /**
   * 保存消息到内存存储中。
   * @param message - 需要保存的消息对象
   */
  saveMessage(message: Message): void {
    this.messages.set(cursorKey(cursorForMessage(message)), cloneMessage(message));
  }

  /**
   * 保存消息游标到内存存储中。
   * 如果游标对应的消息尚未存储，将创建一个占位空消息记录。
   * @param cursor - 需要保存的消息游标
   */
  saveCursor(cursor: MessageCursor): void {
    const key = cursorKey(cursor);
    if (!this.messages.has(key)) {
      this.messages.set(key, {
        recipient: { nodeId: "0", userId: "0" },
        nodeId: cursor.nodeId,
        seq: cursor.seq,
        sender: { nodeId: "0", userId: "0" },
        body: new Uint8Array(0),
        createdAtHlc: ""
      });
    }
    if (!this.order.some((item) => item.nodeId === cursor.nodeId && item.seq === cursor.seq)) {
      this.order.push({ ...cursor });
    }
  }

  /**
   * 检查指定游标是否已存在于存储中。
   * 用于去重判断。
   * @param cursor - 消息游标
   * @returns 如果已存在返回 true，否则返回 false
   */
  hasCursor(cursor: MessageCursor): boolean {
    return this.messages.has(cursorKey(cursor));
  }

  /**
   * 根据游标获取对应的消息。
   * @param cursor - 消息游标
   * @returns 消息对象的副本，如果找不到则返回 undefined
   */
  message(cursor: MessageCursor): Message | undefined {
    const message = this.messages.get(cursorKey(cursor));
    return message == null ? undefined : cloneMessage(message);
  }
}

function cursorKey(cursor: MessageCursor): string {
  return `${cursor.nodeId}:${cursor.seq}`;
}

function cloneMessage(message: Message): Message {
  return {
    recipient: { ...message.recipient },
    nodeId: message.nodeId,
    seq: message.seq,
    sender: { ...message.sender },
    body: new Uint8Array(message.body),
    createdAtHlc: message.createdAtHlc
  };
}
