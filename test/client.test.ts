import bcrypt from "bcryptjs";
import { createServer, type Server as HTTPServer } from "node:http";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  Client,
  ConnectionError,
  DeliveryMode,
  MemoryCursorStore,
  NopHandler,
  ProtocolError,
  ServerError,
  plainPasswordSync,
  proto,
  type CursorStore,
  type LoginInfo,
  type Message,
  type MessageCursor,
  type Packet
} from "../src/index";
import type { UserRef } from "../src/types";

const originalWebSocket = globalThis.WebSocket;

beforeAll(() => {
  globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
});

afterAll(() => {
  globalThis.WebSocket = originalWebSocket;
});

describe("Client", () => {
  it("connects, acks pushed messages, persists send responses, and pings", async () => {
    const server = await TestServer.start();
    const store = new RecordingStore();
    const handler = new RecordingHandler();
    const client = new Client({
      baseUrl: server.baseUrl(),
      credentials: {
        nodeId: "4096",
        userId: "1025",
        password: plainPasswordSync("alice-password")
      },
      cursorStore: store,
      handler,
      requestTimeoutMs: 200,
      pingIntervalMs: 60_000
    });

    try {
      const connectPromise = client.connect();
      const conn = await server.nextConnection();
      const login = await conn.readClientEnvelope();
      const loginBody = clientBody(login, "login");

      expect(conn.path).toBe("/ws/client");
      expect(loginBody.login.user).toEqual({ nodeId: "4096", userId: "1025" });
      expect(bcrypt.compareSync("alice-password", loginBody.login.password)).toBe(true);
      expect(loginBody.login.seenMessages).toEqual([]);

      await conn.sendServerEnvelope({
        body: {
          oneofKind: "loginResponse",
          loginResponse: {
            user: {
              nodeId: "4096",
              userId: "1025",
              username: "alice",
              loginName: "alice-login",
              role: "user",
              profileJson: new Uint8Array(0),
              systemReserved: false,
              createdAt: "",
              updatedAt: "",
              originNodeId: "4096"
            },
            protocolVersion: "client-v1alpha1",
            sessionRef: sessionRefRecord("session-alice")
          }
        }
      });
      await connectPromise;
      expect(client.sessionRef).toEqual({ servingNodeId: "4096", sessionId: "session-alice" });

      await conn.sendServerEnvelope({
        body: {
          oneofKind: "messagePushed",
          messagePushed: {
            message: {
              recipient: { nodeId: "4096", userId: "1025" },
              nodeId: "4096",
              seq: "7",
              sender: { nodeId: "4096", userId: "1" },
              body: new Uint8Array([0xff, 0x00]),
              createdAtHlc: "hlc1"
            }
          }
        }
      });
      const ack1 = await conn.readClientEnvelope();
      expect(clientBody(ack1, "ackMessage").ackMessage.cursor).toEqual({ nodeId: "4096", seq: "7" });

      const sendPromise = client.sendMessage({ nodeId: "4096", userId: "1025" }, Buffer.from("payload"));
      const sendRequest = await conn.readClientEnvelope();
      const sendBody = clientBody(sendRequest, "sendMessage");
      expect(sendBody.sendMessage.deliveryKind).toBe(proto.ClientDeliveryKind.PERSISTENT);
      expect(Array.from(sendBody.sendMessage.body)).toEqual(Array.from(Buffer.from("payload")));

      await conn.sendServerEnvelope({
        body: {
          oneofKind: "sendMessageResponse",
          sendMessageResponse: {
            requestId: sendBody.sendMessage.requestId,
            body: {
              oneofKind: "message",
              message: {
                recipient: { nodeId: "4096", userId: "1025" },
                nodeId: "4096",
                seq: "8",
                sender: { nodeId: "4096", userId: "1025" },
                body: Buffer.from("payload"),
                createdAtHlc: "hlc2"
              }
            }
          }
        }
      });
      const ack2 = await conn.readClientEnvelope();
      expect(clientBody(ack2, "ackMessage").ackMessage.cursor).toEqual({ nodeId: "4096", seq: "8" });

      const sent = await sendPromise;
      expect(sent.seq).toBe("8");
      expect(sent.sender).toEqual({ nodeId: "4096", userId: "1025" });

      const pingPromise = client.ping();
      const ping = await conn.readClientEnvelope();
      const pingBody = clientBody(ping, "ping");
      await conn.sendServerEnvelope({
        body: {
          oneofKind: "pong",
          pong: { requestId: pingBody.ping.requestId }
        }
      });
      await pingPromise;

      await client.close();

      expect(handler.logins).toHaveLength(1);
      expect(handler.logins[0]?.protocolVersion).toBe("client-v1alpha1");
      expect(handler.logins[0]?.sessionRef).toEqual({ servingNodeId: "4096", sessionId: "session-alice" });
      expect(handler.messages).toHaveLength(2);
      expect(handler.messages[0]?.seq).toBe("7");
      expect(handler.messages[1]?.seq).toBe("8");
      expect(store.saved).toEqual(["message", "cursor", "message", "cursor"]);
      expect(store.loadSeenMessages()).toEqual([
        { nodeId: "4096", seq: "7" },
        { nodeId: "4096", seq: "8" }
      ]);
    } finally {
      await withTimeout(client.close(), "client close", 1_000);
      await withTimeout(server.close(), "server close", 1_000);
    }
  });

  it("uses transient_only login flag and realtime websocket path", async () => {
    const server = await TestServer.start();
    const client = new Client({
      baseUrl: server.baseUrl("/base"),
      credentials: {
        nodeId: "4096",
        userId: "1025",
        password: plainPasswordSync("alice-password")
      },
      transientOnly: true,
      realtimeStream: true,
      requestTimeoutMs: 200,
      pingIntervalMs: 60_000
    });

    try {
      const connectPromise = client.connect();
      const conn = await server.nextConnection();
      const login = await conn.readClientEnvelope();
      const loginBody = clientBody(login, "login");

      expect(conn.path).toBe("/base/ws/realtime");
      expect(loginBody.login.transientOnly).toBe(true);

      await conn.sendServerEnvelope(loginResponseEnvelope());
      await connectPromise;
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("supports login_name credentials during websocket login", async () => {
    const server = await TestServer.start();
    const handler = new RecordingHandler();
    const client = new Client({
      baseUrl: server.baseUrl(),
      credentials: {
        loginName: "alice-login",
        password: plainPasswordSync("alice-password")
      },
      handler,
      requestTimeoutMs: 200,
      pingIntervalMs: 60_000
    });

    try {
      const connectPromise = client.connect();
      const conn = await server.nextConnection();
      const login = await conn.readClientEnvelope();
      const loginBody = clientBody(login, "login");

      expect(loginBody.login.user).toBeUndefined();
      expect(loginBody.login.loginName).toBe("alice-login");
      expect(bcrypt.compareSync("alice-password", loginBody.login.password)).toBe(true);

      await conn.sendServerEnvelope(loginResponseEnvelope("session-login-name", "alice-login"));
      await connectPromise;

      expect(handler.logins[0]?.user.loginName).toBe("alice-login");
      expect(client.sessionRef).toEqual({
        servingNodeId: "4096",
        sessionId: "session-login-name"
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("stops reconnecting after unauthorized login failure", async () => {
    const server = await TestServer.start();
    const client = new Client({
      baseUrl: server.baseUrl(),
      credentials: {
        nodeId: "4096",
        userId: "1025",
        password: plainPasswordSync("wrong-password")
      },
      reconnect: true,
      initialReconnectDelayMs: 10,
      maxReconnectDelayMs: 20,
      requestTimeoutMs: 200,
      pingIntervalMs: 60_000
    });

    try {
      const connectPromise = client.connect();
      const conn = await server.nextConnection();
      await conn.readClientEnvelope();
      await conn.sendServerEnvelope({
        body: {
          oneofKind: "error",
          error: {
            code: "unauthorized",
            message: "bad credentials",
            requestId: "0"
          }
        }
      });

      await expect(connectPromise).rejects.toBeInstanceOf(ServerError);
      try {
        await connectPromise;
      } catch (error) {
        expect(error).toBeInstanceOf(ServerError);
        expect((error as ServerError).unauthorized()).toBe(true);
      }

      await delay(100);
      expect(server.connectionCount).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("reconnects with seen_messages from the cursor store", async () => {
    const server = await TestServer.start();
    const store = new RecordingStore();
    const handler = new RecordingHandler();
    const client = new Client({
      baseUrl: server.baseUrl(),
      credentials: {
        nodeId: "4096",
        userId: "1025",
        password: plainPasswordSync("alice-password")
      },
      cursorStore: store,
      handler,
      reconnect: true,
      initialReconnectDelayMs: 10,
      maxReconnectDelayMs: 20,
      requestTimeoutMs: 200,
      pingIntervalMs: 60_000
    });

    try {
      const connectPromise = client.connect();
      const first = await withTimeout(server.nextConnection(), "first connection");
      const firstLogin = await withTimeout(first.readClientEnvelope(), "first login");
      expect(clientBody(firstLogin, "login").login.seenMessages).toEqual([]);
      await first.sendServerEnvelope(loginResponseEnvelope());
      await withTimeout(connectPromise, "initial connect");

      await first.sendServerEnvelope({
        body: {
          oneofKind: "messagePushed",
          messagePushed: {
            message: {
              recipient: { nodeId: "4096", userId: "1025" },
              nodeId: "4096",
              seq: "11",
              sender: { nodeId: "4096", userId: "1" },
              body: Buffer.from("hello"),
              createdAtHlc: "hlc1"
            }
          }
        }
      });
      await withTimeout(first.readClientEnvelope(), "first ack");
      await first.terminate();

      await delay(150);
      expect(
        server.connectionCount,
        `errors=${handler.errors.map(stringifyError).join(" | ")} disconnects=${handler.disconnects.map(stringifyError).join(" | ")}`
      ).toBeGreaterThanOrEqual(2);

      const second = await withTimeout(server.nextConnection(), "second connection");
      const secondLogin = await withTimeout(second.readClientEnvelope(), "second login");
      expect(clientBody(secondLogin, "login").login.seenMessages).toEqual([{ nodeId: "4096", seq: "11" }]);
      await second.sendServerEnvelope(loginResponseEnvelope());
    } finally {
      await withTimeout(client.close(), "client close", 1_000);
      await withTimeout(server.close(), "server close", 1_000);
    }
  });

  it("handles representative management and query RPCs", async () => {
    const server = await TestServer.start();
    const client = new Client({
      baseUrl: server.baseUrl(),
      credentials: {
        nodeId: "4096",
        userId: "1025",
        password: plainPasswordSync("alice-password")
      },
      requestTimeoutMs: 200,
      pingIntervalMs: 60_000
    });

    const target: UserRef = { nodeId: "4096", userId: "1025" };
    const channel: UserRef = { nodeId: "4096", userId: "2048" };
    const blocked: UserRef = { nodeId: "4096", userId: "4097" };

    try {
      const connectPromise = client.connect();
      const conn = await server.nextConnection();
      await conn.readClientEnvelope();
      await conn.sendServerEnvelope(loginResponseEnvelope());
      await connectPromise;

      const createPromise = client.createUser({
        username: "alice",
        loginName: "alice-login",
        password: plainPasswordSync("alice-password"),
        profileJson: Buffer.from("{\"display_name\":\"Alice\"}"),
        role: "user"
      });
      const createReq = await conn.readClientEnvelope();
      const createBody = clientBody(createReq, "createUser");
      expect(bcrypt.compareSync("alice-password", createBody.createUser.password)).toBe(true);
      expect(createBody.createUser.loginName).toBe("alice-login");
      await conn.sendServerEnvelope({
        body: {
          oneofKind: "createUserResponse",
          createUserResponse: {
            requestId: createBody.createUser.requestId,
            user: userRecord("alice", "user", "alice-login")
          }
        }
      });
      const createdUser = await createPromise;
      expect(createdUser.username).toBe("alice");
      expect(createdUser.loginName).toBe("alice-login");

      const getUserPromise = client.getUser(target);
      const getUserReq = await conn.readClientEnvelope();
      const getUserBody = clientBody(getUserReq, "getUser");
      expect(getUserBody.getUser.user).toEqual(target);
      await conn.sendServerEnvelope({
        body: {
          oneofKind: "getUserResponse",
          getUserResponse: {
            requestId: getUserBody.getUser.requestId,
            user: userRecord("alice")
          }
        }
      });
      expect((await getUserPromise).userId).toBe("1025");

      const updatePromise = client.updateUser(target, {
        username: "alice-2",
        loginName: "",
        password: plainPasswordSync("new-password"),
        profileJson: Buffer.from("{\"display_name\":\"Alice 2\"}"),
        role: "admin"
      });
      const updateReq = await conn.readClientEnvelope();
      const updateBody = clientBody(updateReq, "updateUser");
      expect(updateBody.updateUser.username?.value).toBe("alice-2");
      expect(updateBody.updateUser.loginName?.value).toBe("");
      expect(updateBody.updateUser.role?.value).toBe("admin");
      expect(Array.from(updateBody.updateUser.profileJson?.value ?? new Uint8Array(0))).toEqual(
        Array.from(Buffer.from("{\"display_name\":\"Alice 2\"}"))
      );
      expect(bcrypt.compareSync("new-password", updateBody.updateUser.password?.value ?? "")).toBe(true);
      await conn.sendServerEnvelope({
        body: {
          oneofKind: "updateUserResponse",
          updateUserResponse: {
            requestId: updateBody.updateUser.requestId,
            user: userRecord("alice-2", "admin", "")
          }
        }
      });
      const updatedUser = await updatePromise;
      expect(updatedUser.role).toBe("admin");
      expect(updatedUser.loginName).toBe("");

      const deletePromise = client.deleteUser(target);
      const deleteReq = await conn.readClientEnvelope();
      const deleteBody = clientBody(deleteReq, "deleteUser");
      await conn.sendServerEnvelope({
        body: {
          oneofKind: "deleteUserResponse",
          deleteUserResponse: {
            requestId: deleteBody.deleteUser.requestId,
            status: "deleted",
            user: target
          }
        }
      });
      expect((await deletePromise).status).toBe("deleted");

      const upsertMetadataPromise = client.upsertUserMetadata(target, "session:web:1", {
        value: new Uint8Array([0xff, 0x00, 0x78]),
        expiresAt: "2026-04-29T00:00:00Z"
      });
      const upsertMetadataReq = await conn.readClientEnvelope();
      const upsertMetadataBody = clientBody(upsertMetadataReq, "upsertUserMetadata");
      expect(upsertMetadataBody.upsertUserMetadata.owner).toEqual(target);
      expect(upsertMetadataBody.upsertUserMetadata.key).toBe("session:web:1");
      expect(Array.from(upsertMetadataBody.upsertUserMetadata.value)).toEqual([0xff, 0x00, 0x78]);
      expect(upsertMetadataBody.upsertUserMetadata.expiresAt?.value).toBe("2026-04-29T00:00:00Z");
      await conn.sendServerEnvelope({
        body: {
          oneofKind: "upsertUserMetadataResponse",
          upsertUserMetadataResponse: {
            requestId: upsertMetadataBody.upsertUserMetadata.requestId,
            metadata: userMetadataRecord(target, "session:web:1", new Uint8Array([0xff, 0x00, 0x78]), {
              expiresAt: "2026-04-29T00:00:00Z"
            })
          }
        }
      });
      expect((await upsertMetadataPromise).expiresAt).toBe("2026-04-29T00:00:00Z");

      const getMetadataPromise = client.getUserMetadata(target, "session:web:1");
      const getMetadataReq = await conn.readClientEnvelope();
      const getMetadataBody = clientBody(getMetadataReq, "getUserMetadata");
      expect(getMetadataBody.getUserMetadata.owner).toEqual(target);
      expect(getMetadataBody.getUserMetadata.key).toBe("session:web:1");
      await conn.sendServerEnvelope({
        body: {
          oneofKind: "getUserMetadataResponse",
          getUserMetadataResponse: {
            requestId: getMetadataBody.getUserMetadata.requestId,
            metadata: userMetadataRecord(target, "session:web:1", new Uint8Array([0xff, 0x00, 0x78]), {
              expiresAt: "2026-04-29T00:00:00Z"
            })
          }
        }
      });
      expect(Array.from((await getMetadataPromise).value)).toEqual([0xff, 0x00, 0x78]);

      const scanMetadataPromise = client.scanUserMetadata(target, {
        prefix: "session:",
        after: "session:web:1",
        limit: 1
      });
      const scanMetadataReq = await conn.readClientEnvelope();
      const scanMetadataBody = clientBody(scanMetadataReq, "scanUserMetadata");
      expect(scanMetadataBody.scanUserMetadata.owner).toEqual(target);
      expect(scanMetadataBody.scanUserMetadata.prefix).toBe("session:");
      expect(scanMetadataBody.scanUserMetadata.after).toBe("session:web:1");
      expect(scanMetadataBody.scanUserMetadata.limit).toBe(1);
      await conn.sendServerEnvelope({
        body: {
          oneofKind: "scanUserMetadataResponse",
          scanUserMetadataResponse: {
            requestId: scanMetadataBody.scanUserMetadata.requestId,
            items: [
              userMetadataRecord(target, "session:web:2", Buffer.from("second"))
            ],
            count: 1,
            nextAfter: ""
          }
        }
      });
      const scannedMetadata = await scanMetadataPromise;
      expect(scannedMetadata.count).toBe(1);
      expect(scannedMetadata.items[0]?.key).toBe("session:web:2");

      const deleteMetadataPromise = client.deleteUserMetadata(target, "session:web:1");
      const deleteMetadataReq = await conn.readClientEnvelope();
      const deleteMetadataBody = clientBody(deleteMetadataReq, "deleteUserMetadata");
      expect(deleteMetadataBody.deleteUserMetadata.owner).toEqual(target);
      expect(deleteMetadataBody.deleteUserMetadata.key).toBe("session:web:1");
      await conn.sendServerEnvelope({
        body: {
          oneofKind: "deleteUserMetadataResponse",
          deleteUserMetadataResponse: {
            requestId: deleteMetadataBody.deleteUserMetadata.requestId,
            metadata: userMetadataRecord(target, "session:web:1", new Uint8Array([0xff, 0x00, 0x78]), {
              deletedAt: "2026-04-28T03:10:00Z",
              expiresAt: "2026-04-29T00:00:00Z"
            })
          }
        }
      });
      expect((await deleteMetadataPromise).deletedAt).toBe("2026-04-28T03:10:00Z");

      const subscribePromise = client.subscribeChannel(target, channel);
      const subscribeReq = await conn.readClientEnvelope();
      const subscribeBody = clientBody(subscribeReq, "upsertUserAttachment");
      await conn.sendServerEnvelope({
        body: {
          oneofKind: "upsertUserAttachmentResponse",
          upsertUserAttachmentResponse: {
            requestId: subscribeBody.upsertUserAttachment.requestId,
            attachment: attachmentRecord(proto.AttachmentType.CHANNEL_SUBSCRIPTION, target, channel)
          }
        }
      });
      expect((await subscribePromise).channel).toEqual(channel);

      const listSubscriptionsPromise = client.listSubscriptions(target);
      const listSubscriptionsReq = await conn.readClientEnvelope();
      const listSubscriptionsBody = clientBody(listSubscriptionsReq, "listUserAttachments");
      await conn.sendServerEnvelope({
        body: {
          oneofKind: "listUserAttachmentsResponse",
          listUserAttachmentsResponse: {
            requestId: listSubscriptionsBody.listUserAttachments.requestId,
            items: [attachmentRecord(proto.AttachmentType.CHANNEL_SUBSCRIPTION, target, channel)],
            count: 1
          }
        }
      });
      expect(await listSubscriptionsPromise).toHaveLength(1);

      const unsubscribePromise = client.unsubscribeChannel(target, channel);
      const unsubscribeReq = await conn.readClientEnvelope();
      const unsubscribeBody = clientBody(unsubscribeReq, "deleteUserAttachment");
      await conn.sendServerEnvelope({
        body: {
          oneofKind: "deleteUserAttachmentResponse",
          deleteUserAttachmentResponse: {
            requestId: unsubscribeBody.deleteUserAttachment.requestId,
            attachment: attachmentRecord(proto.AttachmentType.CHANNEL_SUBSCRIPTION, target, channel)
          }
        }
      });
      expect((await unsubscribePromise).subscriber).toEqual(target);

      const blockPromise = client.blockUser(target, blocked);
      const blockReq = await conn.readClientEnvelope();
      const blockBody = clientBody(blockReq, "upsertUserAttachment");
      await conn.sendServerEnvelope({
        body: {
          oneofKind: "upsertUserAttachmentResponse",
          upsertUserAttachmentResponse: {
            requestId: blockBody.upsertUserAttachment.requestId,
            attachment: attachmentRecord(proto.AttachmentType.USER_BLACKLIST, target, blocked)
          }
        }
      });
      expect((await blockPromise).blocked).toEqual(blocked);

      const listBlockedPromise = client.listBlockedUsers(target);
      const listBlockedReq = await conn.readClientEnvelope();
      const listBlockedBody = clientBody(listBlockedReq, "listUserAttachments");
      await conn.sendServerEnvelope({
        body: {
          oneofKind: "listUserAttachmentsResponse",
          listUserAttachmentsResponse: {
            requestId: listBlockedBody.listUserAttachments.requestId,
            items: [attachmentRecord(proto.AttachmentType.USER_BLACKLIST, target, blocked)],
            count: 1
          }
        }
      });
      expect(await listBlockedPromise).toHaveLength(1);

      const unblockPromise = client.unblockUser(target, blocked);
      const unblockReq = await conn.readClientEnvelope();
      const unblockBody = clientBody(unblockReq, "deleteUserAttachment");
      await conn.sendServerEnvelope({
        body: {
          oneofKind: "deleteUserAttachmentResponse",
          deleteUserAttachmentResponse: {
            requestId: unblockBody.deleteUserAttachment.requestId,
            attachment: attachmentRecord(proto.AttachmentType.USER_BLACKLIST, target, blocked)
          }
        }
      });
      expect((await unblockPromise).owner).toEqual(target);

      const listMessagesPromise = client.listMessages(target, 5);
      const listMessagesReq = await conn.readClientEnvelope();
      const listMessagesBody = clientBody(listMessagesReq, "listMessages");
      expect(listMessagesBody.listMessages.limit).toBe(5);
      await conn.sendServerEnvelope({
        body: {
          oneofKind: "listMessagesResponse",
          listMessagesResponse: {
            requestId: listMessagesBody.listMessages.requestId,
            items: [messageRecord("21")],
            count: 1
          }
        }
      });
      expect((await listMessagesPromise)[0]?.seq).toBe("21");

      const listEventsPromise = client.listEvents("7", 3);
      const listEventsReq = await conn.readClientEnvelope();
      const listEventsBody = clientBody(listEventsReq, "listEvents");
      expect(listEventsBody.listEvents.after).toBe("7");
      expect(listEventsBody.listEvents.limit).toBe(3);
      await conn.sendServerEnvelope({
        body: {
          oneofKind: "listEventsResponse",
          listEventsResponse: {
            requestId: listEventsBody.listEvents.requestId,
            items: [
              {
                sequence: "8",
                eventId: "88",
                eventType: "user.created",
                aggregate: "user",
                aggregateNodeId: "4096",
                aggregateId: "1025",
                hlc: "hlc1",
                originNodeId: "4096",
                eventJson: Buffer.from("{\"ok\":true}")
              }
            ],
            count: 1
          }
        }
      });
      expect((await listEventsPromise)[0]?.eventId).toBe("88");

      const listClusterNodesPromise = client.listClusterNodes();
      const listClusterNodesReq = await conn.readClientEnvelope();
      const listClusterNodesBody = clientBody(listClusterNodesReq, "listClusterNodes");
      await conn.sendServerEnvelope({
        body: {
          oneofKind: "listClusterNodesResponse",
          listClusterNodesResponse: {
            requestId: listClusterNodesBody.listClusterNodes.requestId,
            items: [
              { nodeId: "4096", isLocal: true, configuredUrl: "", source: "local" },
              { nodeId: "8192", isLocal: false, configuredUrl: "ws://127.0.0.1:9081/internal/cluster/ws", source: "discovered" }
            ],
            count: 2
          }
        }
      });
      expect((await listClusterNodesPromise)[1]?.source).toBe("discovered");

      const listLoggedInPromise = client.listNodeLoggedInUsers("4096");
      const listLoggedInReq = await conn.readClientEnvelope();
      const listLoggedInBody = clientBody(listLoggedInReq, "listNodeLoggedInUsers");
      expect(listLoggedInBody.listNodeLoggedInUsers.nodeId).toBe("4096");
      await conn.sendServerEnvelope({
        body: {
          oneofKind: "listNodeLoggedInUsersResponse",
          listNodeLoggedInUsersResponse: {
            requestId: listLoggedInBody.listNodeLoggedInUsers.requestId,
            targetNodeId: "4096",
            items: [
              { nodeId: "4096", userId: "1025", username: "alice", loginName: "alice-login" },
              { nodeId: "4096", userId: "1026", username: "bob", loginName: "" }
            ],
            count: 2
          }
        }
      });
      const loggedInUsers = await listLoggedInPromise;
      expect(loggedInUsers[1]?.username).toBe("bob");
      expect(loggedInUsers[0]?.loginName).toBe("alice-login");
      expect(loggedInUsers[1]?.loginName).toBe("");

      const statusPromise = client.operationsStatus();
      const statusReq = await conn.readClientEnvelope();
      const statusBody = clientBody(statusReq, "operationsStatus");
      await conn.sendServerEnvelope({
        body: {
          oneofKind: "operationsStatusResponse",
          operationsStatusResponse: {
            requestId: statusBody.operationsStatus.requestId,
            status: {
              nodeId: "4096",
              messageWindowSize: 128,
              lastEventSequence: "42",
              writeGateReady: true,
              conflictTotal: "3",
              messageTrim: {
                trimmedTotal: "1",
                lastTrimmedAt: "2026-04-28T00:00:00Z"
              },
              projection: {
                pendingTotal: "2",
                lastFailedAt: ""
              },
              peers: [
                {
                  nodeId: "8192",
                  configuredUrl: "ws://127.0.0.1:9081/internal/cluster/ws",
                  connected: true,
                  sessionDirection: "outbound",
                  origins: [
                    {
                      originNodeId: "4096",
                      ackedEventId: "7",
                      appliedEventId: "7",
                      unconfirmedEvents: "0",
                      cursorUpdatedAt: "2026-04-28T00:00:00Z",
                      remoteLastEventId: "8",
                      pendingCatchup: false
                    }
                  ],
                  pendingSnapshotPartitions: 0,
                  remoteSnapshotVersion: "v1",
                  remoteMessageWindowSize: 256,
                  clockOffsetMs: "0",
                  lastClockSync: "2026-04-28T00:00:00Z",
                  snapshotDigestsSentTotal: "1",
                  snapshotDigestsReceivedTotal: "2",
                  snapshotChunksSentTotal: "3",
                  snapshotChunksReceivedTotal: "4",
                  lastSnapshotDigestAt: "2026-04-28T00:00:00Z",
                  lastSnapshotChunkAt: "2026-04-28T00:00:01Z",
                  source: "configured",
                  discoveredUrl: "ws://127.0.0.1:9081/internal/cluster/ws",
                  discoveryState: "connected",
                  lastDiscoveredAt: "2026-04-28T00:00:00Z",
                  lastConnectedAt: "2026-04-28T00:00:01Z",
                  lastDiscoveryError: ""
                }
              ]
            }
          }
        }
      });
      expect((await statusPromise).peers[0]?.sessionDirection).toBe("outbound");

      const metricsPromise = client.metrics();
      const metricsReq = await conn.readClientEnvelope();
      const metricsBody = clientBody(metricsReq, "metrics");
      await conn.sendServerEnvelope({
        body: {
          oneofKind: "metricsResponse",
          metricsResponse: {
            requestId: metricsBody.metrics.requestId,
            text: "# HELP turntf_up 1\nturntf_up 1\n"
          }
        }
      });
      expect(await metricsPromise).toContain("turntf_up 1");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("resolves sessions and targets transient packets to a specific session", async () => {
    const server = await TestServer.start();
    const handler = new RecordingHandler();
    const client = new Client({
      baseUrl: server.baseUrl(),
      credentials: {
        nodeId: "4096",
        userId: "1025",
        password: plainPasswordSync("alice-password")
      },
      handler,
      requestTimeoutMs: 200,
      pingIntervalMs: 60_000
    });

    const target: UserRef = { nodeId: "8192", userId: "1025" };

    try {
      const connectPromise = client.connect();
      const conn = await server.nextConnection();
      await conn.readClientEnvelope();
      await conn.sendServerEnvelope(loginResponseEnvelope("session-alice"));
      await connectPromise;

      expect(client.sessionRef).toEqual({ servingNodeId: "4096", sessionId: "session-alice" });
      expect(handler.logins[0]?.sessionRef).toEqual({ servingNodeId: "4096", sessionId: "session-alice" });

      const resolvePromise = client.resolveUserSessions(target);
      const resolveReq = await conn.readClientEnvelope();
      const resolveBody = clientBody(resolveReq, "resolveUserSessions");
      expect(resolveBody.resolveUserSessions.user).toEqual(target);

      await conn.sendServerEnvelope({
        body: {
          oneofKind: "resolveUserSessionsResponse",
          resolveUserSessionsResponse: {
            requestId: resolveBody.resolveUserSessions.requestId,
            user: target,
            presence: [
              { servingNodeId: "8192", sessionCount: 2, transportHint: "ws" }
            ],
            items: [
              {
                session: sessionRefRecord("session-target-1", "8192"),
                transport: "ws",
                transientCapable: true
              }
            ],
            count: 1
          }
        }
      });

      const resolved = await resolvePromise;
      expect(resolved.user).toEqual(target);
      expect(resolved.presence).toEqual([
        { servingNodeId: "8192", sessionCount: 2, transportHint: "ws" }
      ]);
      expect(resolved.sessions).toEqual([
        {
          session: { servingNodeId: "8192", sessionId: "session-target-1" },
          transport: "ws",
          transientCapable: true
        }
      ]);

      const sendPromise = client.sendPacket(
        target,
        Buffer.from("payload"),
        DeliveryMode.RouteRetry,
        { targetSession: resolved.sessions[0]!.session }
      );
      const sendReq = await conn.readClientEnvelope();
      const sendBody = clientBody(sendReq, "sendMessage");
      expect(sendBody.sendMessage.targetSession).toEqual(sessionRefRecord("session-target-1", "8192"));

      await conn.sendServerEnvelope({
        body: {
          oneofKind: "sendMessageResponse",
          sendMessageResponse: {
            requestId: sendBody.sendMessage.requestId,
            body: {
              oneofKind: "transientAccepted",
              transientAccepted: {
                packetId: "77",
                sourceNodeId: "4096",
                targetNodeId: "8192",
                recipient: target,
                deliveryMode: proto.ClientDeliveryMode.ROUTE_RETRY,
                targetSession: sessionRefRecord("session-target-1", "8192")
              }
            }
          }
        }
      });

      const accepted = await sendPromise;
      expect(accepted.targetSession).toEqual({
        servingNodeId: "8192",
        sessionId: "session-target-1"
      });

      await conn.sendServerEnvelope({
        body: {
          oneofKind: "packetPushed",
          packetPushed: {
            packet: {
              packetId: "78",
              sourceNodeId: "8192",
              targetNodeId: "4096",
              recipient: { nodeId: "4096", userId: "1025" },
              sender: target,
              body: Buffer.from("reply"),
              deliveryMode: proto.ClientDeliveryMode.BEST_EFFORT,
              targetSession: sessionRefRecord("session-alice")
            }
          }
        }
      });

      await withTimeout(waitFor(() => handler.packets.length === 1), "targeted packet");
      expect(handler.packets[0]?.targetSession).toEqual({
        servingNodeId: "4096",
        sessionId: "session-alice"
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("routes request-scoped server errors by request_id even when responses arrive out of order", async () => {
    const server = await TestServer.start();
    const client = new Client({
      baseUrl: server.baseUrl(),
      credentials: {
        nodeId: "4096",
        userId: "1025",
        password: plainPasswordSync("alice-password")
      },
      requestTimeoutMs: 200,
      pingIntervalMs: 60_000
    });

    try {
      const connectPromise = client.connect();
      const conn = await server.nextConnection();
      await conn.readClientEnvelope();
      await conn.sendServerEnvelope(loginResponseEnvelope());
      await connectPromise;

      const metricsPromise = client.metrics();
      const statusPromise = client.operationsStatus();

      const first = await conn.readClientEnvelope();
      const second = await conn.readClientEnvelope();
      const firstBody = clientBody(first, "metrics");
      const secondBody = clientBody(second, "operationsStatus");

      await conn.sendServerEnvelope({
        body: {
          oneofKind: "error",
          error: {
            code: "denied",
            message: "no access",
            requestId: secondBody.operationsStatus.requestId
          }
        }
      });
      await conn.sendServerEnvelope({
        body: {
          oneofKind: "metricsResponse",
          metricsResponse: {
            requestId: firstBody.metrics.requestId,
            text: "ok"
          }
        }
      });

      await expect(metricsPromise).resolves.toBe("ok");
      await expect(statusPromise).rejects.toMatchObject({
        code: "denied",
        requestId: secondBody.operationsStatus.requestId
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("times out RPC waits using per-request timeout options", async () => {
    const server = await TestServer.start();
    const client = new Client({
      baseUrl: server.baseUrl(),
      credentials: {
        nodeId: "4096",
        userId: "1025",
        password: plainPasswordSync("alice-password")
      },
      requestTimeoutMs: 1_000,
      pingIntervalMs: 60_000
    });

    try {
      const connectPromise = client.connect();
      const conn = await server.nextConnection();
      await conn.readClientEnvelope();
      await conn.sendServerEnvelope(loginResponseEnvelope());
      await connectPromise;

      const metricsPromise = client.metrics({ timeoutMs: 25 });
      const metricsReq = await conn.readClientEnvelope();
      clientBody(metricsReq, "metrics");

      await expect(metricsPromise).rejects.toThrow("operation timed out");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("reports protocol errors for non-binary websocket frames", async () => {
    const server = await TestServer.start();
    const handler = new RecordingHandler();
    const client = new Client({
      baseUrl: server.baseUrl(),
      credentials: {
        nodeId: "4096",
        userId: "1025",
        password: plainPasswordSync("alice-password")
      },
      handler,
      reconnect: false,
      requestTimeoutMs: 200,
      pingIntervalMs: 60_000
    });

    try {
      const connectPromise = client.connect();
      const conn = await server.nextConnection();
      await conn.readClientEnvelope();
      await conn.sendServerEnvelope(loginResponseEnvelope());
      await connectPromise;

      await conn.sendText("not protobuf");
      const disconnect = await handler.waitForDisconnect();
      expect(disconnect).toBeInstanceOf(ProtocolError);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("reports protocol errors for invalid protobuf binary frames", async () => {
    const server = await TestServer.start();
    const handler = new RecordingHandler();
    const client = new Client({
      baseUrl: server.baseUrl(),
      credentials: {
        nodeId: "4096",
        userId: "1025",
        password: plainPasswordSync("alice-password")
      },
      handler,
      reconnect: false,
      requestTimeoutMs: 200,
      pingIntervalMs: 60_000
    });

    try {
      const connectPromise = client.connect();
      const conn = await server.nextConnection();
      await conn.readClientEnvelope();
      await conn.sendServerEnvelope(loginResponseEnvelope());
      await connectPromise;

      await conn.sendBinary(new Uint8Array([1, 2, 3]));
      const disconnect = await handler.waitForDisconnect();
      expect(disconnect).toBeInstanceOf(ProtocolError);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("lists communicable users over websocket and validates uid filters", async () => {
    const server = await TestServer.start();
    const client = new Client({
      baseUrl: server.baseUrl(),
      credentials: {
        nodeId: "4096",
        userId: "1025",
        password: plainPasswordSync("alice-password")
      },
      requestTimeoutMs: 200,
      pingIntervalMs: 60_000
    });

    try {
      const connectPromise = client.connect();
      const conn = await server.nextConnection();
      await conn.readClientEnvelope();
      await conn.sendServerEnvelope(loginResponseEnvelope("session-alice"));
      await connectPromise;

      const filteredPromise = client.listUsers({
        name: "  alice  ",
        uid: { nodeId: "4096", userId: "1025" }
      });
      const filteredReq = await conn.readClientEnvelope();
      const filteredBody = clientBody(filteredReq, "listUsers");
      expect(filteredBody.listUsers.name).toBe("alice");
      expect(filteredBody.listUsers.uid).toEqual({ nodeId: "4096", userId: "1025" });
      await conn.sendServerEnvelope({
        body: {
          oneofKind: "listUsersResponse",
          listUsersResponse: {
            requestId: filteredBody.listUsers.requestId,
            items: [userRecord("alice", "user", "alice-login")],
            count: 1
          }
        }
      });
      const filtered = await filteredPromise;
      expect(filtered[0]?.loginName).toBe("alice-login");

      const unfilteredPromise = client.listUsers({
        uid: { nodeId: "0", userId: "0" }
      });
      const unfilteredReq = await conn.readClientEnvelope();
      const unfilteredBody = clientBody(unfilteredReq, "listUsers");
      expect(unfilteredBody.listUsers.name).toBe("");
      expect(unfilteredBody.listUsers.uid).toEqual({ nodeId: "0", userId: "0" });
      await conn.sendServerEnvelope({
        body: {
          oneofKind: "listUsersResponse",
          listUsersResponse: {
            requestId: unfilteredBody.listUsers.requestId,
            items: [userRecord("bob", "user", "")],
            count: 1
          }
        }
      });
      const unfiltered = await unfilteredPromise;
      expect(unfiltered[0]?.loginName).toBe("");

      await expect(client.listUsers({
        uid: { nodeId: "4096", userId: "0" }
      })).rejects.toThrow("request.uid must provide both nodeId and userId together");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

class RecordingStore extends MemoryCursorStore {
  readonly saved: string[] = [];

  override saveMessage(message: Message): void {
    this.saved.push("message");
    super.saveMessage(message);
  }

  override saveCursor(cursor: MessageCursor): void {
    this.saved.push("cursor");
    super.saveCursor(cursor);
  }
}

class RecordingHandler extends NopHandler {
  readonly logins: LoginInfo[] = [];
  readonly messages: Message[] = [];
  readonly packets: Packet[] = [];
  readonly errors: unknown[] = [];
  readonly disconnects: unknown[] = [];
  private readonly disconnectWaiters: Array<(error: unknown) => void> = [];

  override onLogin(info: LoginInfo): void {
    this.logins.push(info);
  }

  override onMessage(message: Message): void {
    this.messages.push(message);
  }

  override onPacket(packet: Packet): void {
    this.packets.push(packet);
  }

  override onError(error: unknown): void {
    this.errors.push(error);
  }

  override onDisconnect(error: unknown): void {
    this.disconnects.push(error);
    this.disconnectWaiters.shift()?.(error);
  }

  waitForDisconnect(): Promise<unknown> {
    if (this.disconnects.length > 0) {
      return Promise.resolve(this.disconnects[this.disconnects.length - 1]);
    }
    return new Promise((resolve) => {
      this.disconnectWaiters.push(resolve);
    });
  }
}

class TestServer {
  private readonly waiters: Array<(connection: TestConnection) => void> = [];
  private readonly connections: TestConnection[] = [];
  private readonly allConnections = new Set<TestConnection>();

  private constructor(
    private readonly server: HTTPServer,
    private readonly wsServer: WebSocketServer,
    readonly port: number
  ) {}

  connectionCount = 0;

  static async start(): Promise<TestServer> {
    const server = createServer();
    const wsServer = new WebSocketServer({ noServer: true });

    server.on("upgrade", (request, socket, head) => {
      wsServer.handleUpgrade(request, socket, head, (ws) => {
        wsServer.emit("connection", ws, request);
      });
    });

    const address = await new Promise<{ port: number }>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const current = server.address();
        if (current == null || typeof current === "string") {
          reject(new Error("server address unavailable"));
          return;
        }
        resolve({ port: current.port });
      });
      server.once("error", reject);
    });

    const instance = new TestServer(server, wsServer, address.port);
    wsServer.on("connection", (socket, request) => {
      const connection = new TestConnection(socket, request.url ?? "");
      instance.allConnections.add(connection);
      instance.connectionCount += 1;
      const waiter = instance.waiters.shift();
      if (waiter == null) {
        instance.connections.push(connection);
      } else {
        waiter(connection);
      }
    });
    return instance;
  }

  baseUrl(path = ""): string {
    return `http://127.0.0.1:${this.port}${path}`;
  }

  nextConnection(): Promise<TestConnection> {
    const connection = this.connections.shift();
    if (connection != null) {
      return Promise.resolve(connection);
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async close(): Promise<void> {
    await Promise.all(Array.from(this.allConnections, (connection) => connection.close()));
    await new Promise<void>((resolve) => this.wsServer.close(() => resolve()));
    await new Promise<void>((resolve, reject) => this.server.close((error) => {
      if (error == null) {
        resolve();
        return;
      }
      reject(error);
    }));
  }
}

class TestConnection {
  private readonly frames: Array<{ data: RawData; isBinary: boolean }> = [];
  private readonly waiters: Array<(frame: { data: RawData; isBinary: boolean }) => void> = [];
  private readonly closePromise: Promise<void>;

  constructor(
    private readonly socket: WebSocket,
    readonly path: string
  ) {
    this.closePromise = new Promise((resolve) => {
      socket.once("close", () => resolve());
    });
    socket.on("message", (data, isBinary) => {
      const frame = { data, isBinary };
      const waiter = this.waiters.shift();
      if (waiter == null) {
        this.frames.push(frame);
      } else {
        waiter(frame);
      }
    });
  }

  async readClientEnvelope(): Promise<proto.ClientEnvelope> {
    const frame = await this.readFrame();
    if (!frame.isBinary) {
      throw new Error("expected binary protobuf frame");
    }
    return proto.ClientEnvelope.fromBinary(rawDataToBytes(frame.data));
  }

  async sendServerEnvelope(envelope: proto.ServerEnvelope): Promise<void> {
    const payload = proto.ServerEnvelope.toBinary(proto.ServerEnvelope.create(envelope));
    await sendFrame(this.socket, payload, true);
  }

  async sendText(text: string): Promise<void> {
    await sendFrame(this.socket, text, false);
  }

  async sendBinary(payload: Uint8Array): Promise<void> {
    await sendFrame(this.socket, payload, true);
  }

  async close(code = 1000, reason = "done"): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) {
      return;
    }
    this.socket.close(code, reason);
    await this.closePromise;
  }

  async terminate(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) {
      return;
    }
    this.socket.terminate();
  }

  private async readFrame(): Promise<{ data: RawData; isBinary: boolean }> {
    const frame = this.frames.shift();
    if (frame != null) {
      return frame;
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

function loginResponseEnvelope(sessionId = "session-alice", loginName = "alice-login"): proto.ServerEnvelope {
  return {
    body: {
      oneofKind: "loginResponse",
      loginResponse: {
        user: userRecord("alice", "user", loginName),
        protocolVersion: "client-v1alpha1",
        sessionRef: sessionRefRecord(sessionId)
      }
    }
  };
}

function sessionRefRecord(sessionId: string, servingNodeId = "4096"): proto.SessionRef {
  return { servingNodeId, sessionId };
}

function clientBody<K extends proto.ClientEnvelope["body"]["oneofKind"]>(
  envelope: proto.ClientEnvelope,
  kind: K
): Extract<proto.ClientEnvelope["body"], { oneofKind: K }> {
  expect(envelope.body.oneofKind).toBe(kind);
  return envelope.body as Extract<proto.ClientEnvelope["body"], { oneofKind: K }>;
}

function userRecord(username: string, role = "user", loginName = "alice-login"): proto.User {
  return {
    nodeId: "4096",
    userId: "1025",
    username,
    loginName,
    role,
    profileJson: Buffer.from("{\"display_name\":\"Alice\"}"),
    systemReserved: false,
    createdAt: "2026-04-28T00:00:00Z",
    updatedAt: "2026-04-28T00:00:00Z",
    originNodeId: "4096"
  };
}

function messageRecord(seq: string): proto.Message {
  return {
    recipient: { nodeId: "4096", userId: "1025" },
    nodeId: "4096",
    seq,
    sender: { nodeId: "4096", userId: "1" },
    body: Buffer.from("hello"),
    createdAtHlc: "hlc-message"
  };
}

function attachmentRecord(
  attachmentType: proto.AttachmentType,
  owner: UserRef,
  subject: UserRef
): proto.Attachment {
  return {
    owner,
    subject,
    attachmentType,
    configJson: Buffer.from("{}"),
    attachedAt: "2026-04-28T00:00:00Z",
    deletedAt: "",
    originNodeId: "4096"
  };
}

function userMetadataRecord(
  owner: UserRef,
  key: string,
  value: Uint8Array,
  overrides: Partial<Pick<proto.UserMetadata, "deletedAt" | "expiresAt" | "updatedAt" | "originNodeId">> = {}
): proto.UserMetadata {
  return {
    owner,
    key,
    value,
    updatedAt: overrides.updatedAt ?? "2026-04-28T03:00:00Z",
    deletedAt: overrides.deletedAt ?? "",
    expiresAt: overrides.expiresAt ?? "",
    originNodeId: overrides.originNodeId ?? "4096"
  };
}

function rawDataToBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((part) => Buffer.isBuffer(part) ? part : Buffer.from(part)));
  }
  if (Buffer.isBuffer(data)) {
    return new Uint8Array(data);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  throw new Error("unsupported frame payload");
}

function sendFrame(socket: WebSocket, payload: Uint8Array | string, binary: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(payload, { binary }, (error) => {
      if (error == null) {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 1_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    })
  ]);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("condition not met");
    }
    await delay(10);
  }
}
