import type { Message, MessageCursor } from "./types";
import { cursorForMessage } from "./validation";

export interface CursorStore {
  loadSeenMessages(): Promise<MessageCursor[]> | MessageCursor[];
  saveMessage(message: Message): Promise<void> | void;
  saveCursor(cursor: MessageCursor): Promise<void> | void;
}

export class MemoryCursorStore implements CursorStore {
  private readonly messages = new Map<string, Message>();
  private readonly order: MessageCursor[] = [];

  loadSeenMessages(): MessageCursor[] {
    return this.order.map((cursor) => ({ ...cursor }));
  }

  saveMessage(message: Message): void {
    this.messages.set(cursorKey(cursorForMessage(message)), cloneMessage(message));
  }

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

  hasCursor(cursor: MessageCursor): boolean {
    return this.messages.has(cursorKey(cursor));
  }

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
