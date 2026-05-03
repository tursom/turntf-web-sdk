import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";

import {
  AttachmentType,
  ConnectionError,
  DeliveryMode,
  HTTPClient,
  ProtocolError,
  plainPasswordSync
} from "../src/index";

describe("HTTPClient", () => {
  it("supports representative HTTP workflows and maps responses to shared SDK types", async () => {
    const calls: Array<{ method: string; path: string; bodyText: string; auth: string }> = [];
    const client = new HTTPClient("http://127.0.0.1:8080", {
      fetch: async (input, init) => {
        const method = init?.method ?? "GET";
        const url = typeof input === "string"
          ? new URL(input)
          : input instanceof URL
            ? input
            : new URL(input.url);
        const path = `${url.pathname}${url.search}`;
        const bodyText = typeof init?.body === "string" ? init.body : "";
        const auth = new Headers(init?.headers).get("Authorization") ?? "";
        calls.push({ method, path, bodyText, auth });

        switch (`${method} ${path}`) {
          case "POST /auth/login":
            return jsonResponse({
              token: "token-1"
            });
          case "POST /users":
            return jsonResponse({
              node_id: 4096,
              user_id: "1025",
              username: "alice",
              login_name: "alice-login",
              role: "user",
              profile: { display_name: "Alice" },
              system_reserved: false,
              created_at: "2026-04-28T00:00:00Z",
              updated_at: "2026-04-28T00:00:00Z",
              origin_node_id: 4096
            }, 201);
          case "GET /nodes/4096/users/1025":
            return jsonResponse({
              node_id: "4096",
              user_id: 1025,
              username: "alice",
              login_name: "alice-login",
              role: "user",
              profile_json: { display_name: "Alice" },
              system_reserved: false,
              created_at: "2026-04-28T00:00:00Z",
              updated_at: "2026-04-28T00:00:00Z",
              origin_node_id: "4096"
            });
          case "PATCH /nodes/4096/users/1025":
            return jsonResponse({
              node_id: "4096",
              user_id: "1025",
              username: "alice-2",
              login_name: "",
              role: "admin",
              profile: { display_name: "Alice 2" },
              system_reserved: false,
              created_at: "2026-04-28T00:00:00Z",
              updated_at: "2026-04-28T01:00:00Z",
              origin_node_id: "4096"
            });
          case "DELETE /nodes/4096/users/1025":
            return jsonResponse({
              status: "deleted",
              user: {
                node_id: 4096,
                user_id: 1025
              }
            });
          case "PUT /nodes/4096/users/1025/metadata/session%3Aweb%3A1":
            return jsonResponse({
              owner: { node_id: 4096, user_id: 1025 },
              key: "session:web:1",
              value: "/wB4",
              updated_at: "2026-04-28T03:00:00Z",
              deleted_at: "",
              expires_at: "2026-04-29T00:00:00Z",
              origin_node_id: "4096"
            }, 201);
          case "GET /nodes/4096/users/1025/metadata/session%3Aweb%3A1":
            return jsonResponse({
              owner: { node_id: "4096", user_id: "1025" },
              key: "session:web:1",
              value: "/wB4",
              updated_at: "2026-04-28T03:00:00Z",
              deleted_at: "",
              expires_at: "2026-04-29T00:00:00Z",
              origin_node_id: 4096
            });
          case "GET /nodes/4096/users/1025/metadata?prefix=session%3A&after=session%3Aweb%3A1&limit=1":
            return jsonResponse({
              items: [
                {
                  owner: { node_id: "4096", user_id: "1025" },
                  key: "session:web:2",
                  value: "c2Vjb25k",
                  updated_at: "2026-04-28T03:05:00Z",
                  deleted_at: "",
                  expires_at: "",
                  origin_node_id: "4096"
                }
              ],
              count: 1,
              next_after: ""
            });
          case "DELETE /nodes/4096/users/1025/metadata/session%3Aweb%3A1":
            return jsonResponse({
              owner: { node_id: "4096", user_id: "1025" },
              key: "session:web:1",
              value: "/wB4",
              updated_at: "2026-04-28T03:00:00Z",
              deleted_at: "2026-04-28T03:10:00Z",
              expires_at: "2026-04-29T00:00:00Z",
              origin_node_id: "4096"
            });
          case "PUT /nodes/4096/users/1025/attachments/channel_subscription/4096/2048":
            return jsonResponse({
              owner: { node_id: 4096, user_id: 1025 },
              subject: { node_id: 4096, user_id: 2048 },
              attachment_type: "channel_subscription",
              config_json: {},
              attached_at: "2026-04-28T00:00:00Z",
              deleted_at: "",
              origin_node_id: "4096"
            }, 201);
          case "GET /nodes/4096/users/1025/attachments?attachment_type=channel_subscription":
            return jsonResponse({
              items: [
                {
                  owner: { node_id: "4096", user_id: "1025" },
                  subject: { node_id: 4096, user_id: 2048 },
                  attachment_type: "channel_subscription",
                  config_json: {},
                  attached_at: "2026-04-28T00:00:00Z",
                  deleted_at: "",
                  origin_node_id: 4096
                }
              ]
            });
          case "DELETE /nodes/4096/users/1025/attachments/channel_subscription/4096/2048":
            return jsonResponse({
              owner: { node_id: "4096", user_id: "1025" },
              subject: { node_id: "4096", user_id: "2048" },
              attachment_type: "channel_subscription",
              config_json: {},
              attached_at: "2026-04-28T00:00:00Z",
              deleted_at: "2026-04-28T02:00:00Z",
              origin_node_id: "4096"
            });
          case "PUT /nodes/4096/users/1025/attachments/user_blacklist/4096/4097":
            return jsonResponse({
              owner: { node_id: "4096", user_id: "1025" },
              subject: { node_id: "4096", user_id: "4097" },
              attachment_type: "user_blacklist",
              config_json: {},
              attached_at: "2026-04-28T00:00:00Z",
              deleted_at: "",
              origin_node_id: "4096"
            }, 201);
          case "GET /nodes/4096/users/1025/attachments?attachment_type=user_blacklist":
            return jsonResponse([
              {
                owner: { node_id: "4096", user_id: "1025" },
                subject: { node_id: "4096", user_id: "4097" },
                attachment_type: "user_blacklist",
                config_json: {},
                attached_at: "2026-04-28T00:00:00Z",
                deleted_at: "",
                origin_node_id: "4096"
              }
            ]);
          case "DELETE /nodes/4096/users/1025/attachments/user_blacklist/4096/4097":
            return jsonResponse({
              owner: { node_id: "4096", user_id: "1025" },
              subject: { node_id: "4096", user_id: "4097" },
              attachment_type: "user_blacklist",
              config_json: {},
              attached_at: "2026-04-28T00:00:00Z",
              deleted_at: "2026-04-28T02:00:00Z",
              origin_node_id: "4096"
            });
          case "GET /nodes/4096/users/1025/messages?limit=20":
            return jsonResponse([
              {
                recipient: { node_id: 4096, user_id: 1025 },
                node_id: 4096,
                seq: "7",
                sender: { node_id: 4096, user_id: 1 },
                body: "aGVsbG8=",
                created_at_hlc: "hlc-7"
              }
            ]);
          case "POST /nodes/4096/users/1025/messages":
            return jsonResponse({
              recipient: { node_id: "4096", user_id: "1025" },
              node_id: "4096",
              seq: 8,
              sender: { node_id: "4096", user_id: "1025" },
              body: "cGF5bG9hZA==",
              created_at: "hlc-8"
            }, 201);
          case "POST /nodes/8192/users/1025/messages":
            return new Response("", { status: 202 });
          case "GET /cluster/nodes":
            return jsonResponse({
              nodes: [
                { node_id: 4096, is_local: true, configured_url: "", source: "local" },
                { node_id: "8192", is_local: false, configured_url: "ws://127.0.0.1:9081/internal/cluster/ws", source: "discovered" }
              ]
            });
          case "GET /cluster/nodes/4096/logged-in-users":
            return jsonResponse({
              items: [
                { node_id: "4096", user_id: "1025", username: "alice", login_name: "alice-login" },
                { node_id: 4096, user_id: 1026, username: "bob", login_name: "" }
              ]
            });
          case "GET /events?after=7&limit=2":
            return jsonResponse({
              items: [
                {
                  sequence: 8,
                  event_id: "88",
                  event_type: "user.created",
                  aggregate: "user",
                  aggregate_node_id: 4096,
                  aggregate_id: "1025",
                  hlc: "hlc-8",
                  origin_node_id: "4096",
                  event: { ok: true }
                }
              ]
            });
          case "GET /ops/status":
            return jsonResponse({
              node_id: "4096",
              message_window_size: 128,
              last_event_sequence: 42,
              write_gate_ready: true,
              conflict_total: "3",
              message_trim: {
                trimmed_total: "1",
                last_trimmed_at: "2026-04-28T00:00:00Z"
              },
              projection: {
                pending_total: 2,
                last_failed_at: ""
              },
              peers: [
                {
                  node_id: "8192",
                  configured_url: "ws://127.0.0.1:9081/internal/cluster/ws",
                  source: "configured",
                  discovered_url: "ws://127.0.0.1:9081/internal/cluster/ws",
                  discovery_state: "connected",
                  last_discovered_at: "2026-04-28T00:00:00Z",
                  last_connected_at: "2026-04-28T00:00:01Z",
                  last_discovery_error: "",
                  connected: true,
                  session_direction: "outbound",
                  origins: [
                    {
                      origin_node_id: "4096",
                      acked_event_id: 7,
                      applied_event_id: "7",
                      unconfirmed_events: "0",
                      cursor_updated_at: "2026-04-28T00:00:00Z",
                      remote_last_event_id: "8",
                      pending_catchup: false
                    }
                  ],
                  pending_snapshot_partitions: 0,
                  remote_snapshot_version: "v1",
                  remote_message_window_size: 256,
                  clock_offset_ms: "0",
                  last_clock_sync: "2026-04-28T00:00:00Z",
                  snapshot_digests_sent_total: "1",
                  snapshot_digests_received_total: "2",
                  snapshot_chunks_sent_total: "3",
                  snapshot_chunks_received_total: "4",
                  last_snapshot_digest_at: "2026-04-28T00:00:00Z",
                  last_snapshot_chunk_at: "2026-04-28T00:00:01Z"
                }
              ]
            });
          case "GET /metrics":
            return new Response("# HELP turntf_up 1\nturntf_up 1\n", { status: 200 });
          default:
            throw new Error(`unexpected request: ${method} ${path}`);
        }
      }
    });

    const token = await client.login("4096", "1", "root-password");
    expect(token).toBe("token-1");

    const created = await client.createUser(token, {
      username: "alice",
      loginName: "alice-login",
      password: plainPasswordSync("alice-password"),
      profileJson: new TextEncoder().encode("{\"display_name\":\"Alice\"}"),
      role: "user"
    });
    expect(created.userId).toBe("1025");
    expect(created.loginName).toBe("alice-login");
    expect(new TextDecoder().decode(created.profileJson)).toBe("{\"display_name\":\"Alice\"}");

    const fetched = await client.getUser(token, { nodeId: "4096", userId: "1025" });
    expect(fetched.nodeId).toBe("4096");
    expect(fetched.loginName).toBe("alice-login");

    const updated = await client.updateUser(
      token,
      { nodeId: "4096", userId: "1025" },
      {
        username: "alice-2",
        loginName: "",
        password: plainPasswordSync("new-password"),
        profileJson: new TextEncoder().encode("{\"display_name\":\"Alice 2\"}"),
        role: "admin"
      }
    );
    expect(updated.role).toBe("admin");
    expect(updated.loginName).toBe("");
    expect(new TextDecoder().decode(updated.profileJson)).toBe("{\"display_name\":\"Alice 2\"}");

    const deleted = await client.deleteUser(token, { nodeId: "4096", userId: "1025" });
    expect(deleted).toEqual({
      status: "deleted",
      user: { nodeId: "4096", userId: "1025" }
    });

    const upsertedMetadata = await client.upsertUserMetadata(
      token,
      { nodeId: "4096", userId: "1025" },
      "session:web:1",
      {
        value: new Uint8Array([0xff, 0x00, 0x78]),
        expiresAt: "2026-04-29T00:00:00Z"
      }
    );
    expect(upsertedMetadata.key).toBe("session:web:1");
    expect(Array.from(upsertedMetadata.value)).toEqual([0xff, 0x00, 0x78]);

    const fetchedMetadata = await client.getUserMetadata(token, { nodeId: "4096", userId: "1025" }, "session:web:1");
    expect(fetchedMetadata.expiresAt).toBe("2026-04-29T00:00:00Z");

    const scannedMetadata = await client.scanUserMetadata(
      token,
      { nodeId: "4096", userId: "1025" },
      { prefix: "session:", after: "session:web:1", limit: 1 }
    );
    expect(scannedMetadata.count).toBe(1);
    expect(scannedMetadata.items[0]?.key).toBe("session:web:2");
    expect(new TextDecoder().decode(scannedMetadata.items[0]!.value)).toBe("second");

    const deletedMetadata = await client.deleteUserMetadata(
      token,
      { nodeId: "4096", userId: "1025" },
      "session:web:1"
    );
    expect(deletedMetadata.deletedAt).toBe("2026-04-28T03:10:00Z");

    const subscribed = await client.subscribeChannel(
      token,
      { nodeId: "4096", userId: "1025" },
      { nodeId: "4096", userId: "2048" }
    );
    expect(subscribed.channel.userId).toBe("2048");

    const subscriptions = await client.listSubscriptions(token, { nodeId: "4096", userId: "1025" });
    expect(subscriptions).toHaveLength(1);

    const unsubscribed = await client.unsubscribeChannel(
      token,
      { nodeId: "4096", userId: "1025" },
      { nodeId: "4096", userId: "2048" }
    );
    expect(unsubscribed.deletedAt).toBe("2026-04-28T02:00:00Z");

    const blocked = await client.blockUser(
      token,
      { nodeId: "4096", userId: "1025" },
      { nodeId: "4096", userId: "4097" }
    );
    expect(blocked.blocked.userId).toBe("4097");

    const blockedUsers = await client.listBlockedUsers(token, { nodeId: "4096", userId: "1025" });
    expect(blockedUsers).toHaveLength(1);

    const unblocked = await client.unblockUser(
      token,
      { nodeId: "4096", userId: "1025" },
      { nodeId: "4096", userId: "4097" }
    );
    expect(unblocked.deletedAt).toBe("2026-04-28T02:00:00Z");

    const messages = await client.listMessages(token, { nodeId: "4096", userId: "1025" }, 20);
    expect(messages[0]?.seq).toBe("7");
    expect(new TextDecoder().decode(messages[0]!.body)).toBe("hello");

    const sent = await client.postMessage(
      token,
      { nodeId: "4096", userId: "1025" },
      new TextEncoder().encode("payload")
    );
    expect(sent.seq).toBe("8");
    expect(new TextDecoder().decode(sent.body)).toBe("payload");

    await client.postPacket(
      token,
      "8192",
      { nodeId: "8192", userId: "1025" },
      new TextEncoder().encode("packet"),
      DeliveryMode.RouteRetry
    );

    const nodes = await client.listClusterNodes(token);
    expect(nodes[1]?.nodeId).toBe("8192");

    const onlineUsers = await client.listNodeLoggedInUsers(token, "4096");
    expect(onlineUsers[1]?.username).toBe("bob");
    expect(onlineUsers[0]?.loginName).toBe("alice-login");
    expect(onlineUsers[1]?.loginName).toBe("");

    const events = await client.listEvents(token, "7", 2);
    expect(events[0]?.eventId).toBe("88");
    expect(new TextDecoder().decode(events[0]!.eventJson)).toBe("{\"ok\":true}");

    const status = await client.operationsStatus(token);
    expect(status.peers[0]?.sessionDirection).toBe("outbound");
    expect(status.conflictTotal).toBe("3");

    const metrics = await client.metrics(token);
    expect(metrics).toContain("turntf_up 1");

    const loginCall = calls.find((call) => call.method === "POST" && call.path === "/auth/login");
    const loginPayload = JSON.parse(loginCall?.bodyText ?? "{}") as { node_id: number; user_id: number; password: string };
    expect(loginPayload.node_id).toBe(4096);
    expect(loginPayload.user_id).toBe(1);
    expect(bcrypt.compareSync("root-password", loginPayload.password)).toBe(true);

    const createUserCall = calls.find((call) => call.method === "POST" && call.path === "/users");
    expect(createUserCall?.auth).toBe("Bearer token-1");
    expect(JSON.parse(createUserCall?.bodyText ?? "{}")).toMatchObject({
      username: "alice",
      login_name: "alice-login",
      role: "user",
      profile: { display_name: "Alice" }
    });

    const upsertMetadataCall = calls.find((call) => call.method === "PUT" && call.path === "/nodes/4096/users/1025/metadata/session%3Aweb%3A1");
    expect(JSON.parse(upsertMetadataCall?.bodyText ?? "{}")).toEqual({
      value: "/wB4",
      expires_at: "2026-04-29T00:00:00Z"
    });

    const postMessageCall = calls.find((call) => call.method === "POST" && call.path === "/nodes/4096/users/1025/messages");
    expect(JSON.parse(postMessageCall?.bodyText ?? "{}")).toEqual({
      body: "cGF5bG9hZA=="
    });

    const packetCall = calls.find((call) => call.method === "POST" && call.path === "/nodes/8192/users/1025/messages");
    expect(JSON.parse(packetCall?.bodyText ?? "{}")).toEqual({
      body: "cGFja2V0",
      delivery_kind: "transient",
      delivery_mode: "route_retry"
    });
  });

  it("supports login_name authentication and preserves login_name updates", async () => {
    const calls: Array<{ method: string; path: string; bodyText: string }> = [];
    const client = new HTTPClient("http://127.0.0.1:8080", {
      fetch: async (input, init) => {
        const method = init?.method ?? "GET";
        const url = typeof input === "string"
          ? new URL(input)
          : input instanceof URL
            ? input
            : new URL(input.url);
        const path = `${url.pathname}${url.search}`;
        const bodyText = typeof init?.body === "string" ? init.body : "";
        calls.push({ method, path, bodyText });

        switch (`${method} ${path}`) {
          case "POST /auth/login":
            return jsonResponse({ token: "token-login-name" });
          case "PATCH /nodes/4096/users/1025":
            return jsonResponse({
              node_id: "4096",
              user_id: "1025",
              username: "alice",
              login_name: "",
              role: "user",
              profile: { display_name: "Alice" },
              system_reserved: false,
              created_at: "2026-04-28T00:00:00Z",
              updated_at: "2026-04-28T02:00:00Z",
              origin_node_id: "4096"
            });
          default:
            throw new Error(`unexpected request: ${method} ${path}`);
        }
      }
    });

    const token = await client.loginByLoginName("root-login", "root-password");
    expect(token).toBe("token-login-name");

    const updated = await client.updateUser(
      "token-login-name",
      { nodeId: "4096", userId: "1025" },
      { loginName: "" }
    );
    expect(updated.loginName).toBe("");

    const loginCall = calls.find((call) => call.method === "POST" && call.path === "/auth/login");
    const loginPayload = JSON.parse(loginCall?.bodyText ?? "{}") as { login_name: string; password: string };
    expect(loginPayload.login_name).toBe("root-login");
    expect(bcrypt.compareSync("root-password", loginPayload.password)).toBe(true);

    const updateCall = calls.find((call) => call.method === "PATCH" && call.path === "/nodes/4096/users/1025");
    expect(JSON.parse(updateCall?.bodyText ?? "{}")).toEqual({
      login_name: ""
    });
  });

  it("maps HTTP status failures and request timeouts to SDK errors", async () => {
    const failingClient = new HTTPClient("http://127.0.0.1:8080", {
      fetch: async () => new Response("bad credentials", { status: 401 })
    });
    await expect(failingClient.login("4096", "1", "root")).rejects.toBeInstanceOf(ProtocolError);

    const timeoutClient = new HTTPClient("http://127.0.0.1:8080", {
      fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason ?? new Error("operation aborted"));
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(signal.reason ?? new Error("operation aborted"));
        }, { once: true });
      })
    });
    await expect(timeoutClient.metrics("token", { timeoutMs: 20 })).rejects.toBeInstanceOf(ConnectionError);
    await expect(timeoutClient.metrics("token", { timeoutMs: 20 })).rejects.toThrow("operation timed out");
  });

  it("binds the default global fetch implementation for browser-style invocation", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ thisValue: unknown; url: string }> = [];
    const browserStyleFetch = function (
      this: unknown,
      input: RequestInfo | URL
    ): Promise<Response> {
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      calls.push({ thisValue: this, url });
      return Promise.resolve(jsonResponse({ token: "token-bound" }));
    } as typeof fetch;

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: browserStyleFetch
    });

    try {
      const client = new HTTPClient("http://127.0.0.1:8080");
      const token = await client.login("4096", "1", "root-password");
      expect(token).toBe("token-bound");
      expect(calls).toEqual([
        { thisValue: globalThis, url: "http://127.0.0.1:8080/auth/login" }
      ]);
    } finally {
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: originalFetch
      });
    }
  });

  it("serializes empty attachment config as an object and parses wrapped attachment responses", async () => {
    let bodyText = "";
    const client = new HTTPClient("http://127.0.0.1:8080", {
      fetch: async (_input, init) => {
        bodyText = typeof init?.body === "string" ? init.body : "";
        return jsonResponse({
          owner: { node_id: 4096, user_id: 1025 },
          subject: { node_id: 4096, user_id: 2048 },
          attachment_type: "channel_writer",
          config_json: { priority: 1 },
          attached_at: "2026-04-28T00:00:00Z",
          deleted_at: "",
          origin_node_id: "4096"
        }, 201);
      }
    });

    const attachment = await client.upsertAttachment(
      "token",
      { nodeId: "4096", userId: "1025" },
      { nodeId: "4096", userId: "2048" },
      AttachmentType.ChannelWriter
    );
    expect(JSON.parse(bodyText)).toEqual({ config_json: {} });
    expect(new TextDecoder().decode(attachment.configJson)).toBe("{\"priority\":1}");
  });

  it("lists communicable users with name and uid filters", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const client = new HTTPClient("http://127.0.0.1:8080", {
      fetch: async (input, init) => {
        const method = init?.method ?? "GET";
        const url = typeof input === "string"
          ? new URL(input)
          : input instanceof URL
            ? input
            : new URL(input.url);
        const path = `${url.pathname}${url.search}`;
        calls.push({ method, path });

        switch (`${method} ${path}`) {
          case "GET /users?name=alice&uid=4096%3A1025":
            return jsonResponse({
              items: [
                {
                  node_id: "4096",
                  user_id: "1025",
                  username: "alice",
                  login_name: "alice-login",
                  role: "user",
                  profile: { display_name: "Alice" },
                  system_reserved: false,
                  created_at: "2026-04-28T00:00:00Z",
                  updated_at: "2026-04-28T00:00:00Z",
                  origin_node_id: "4096"
                }
              ],
              count: 1
            });
          case "GET /users":
            return jsonResponse([
              {
                node_id: "4096",
                user_id: "1026",
                username: "bob",
                login_name: "",
                role: "user",
                profile: { display_name: "Bob" },
                system_reserved: false,
                created_at: "2026-04-28T00:00:00Z",
                updated_at: "2026-04-28T00:00:00Z",
                origin_node_id: "4096"
              }
            ]);
          default:
            throw new Error(`unexpected request: ${method} ${path}`);
        }
      }
    });

    const filtered = await client.listUsers("user-token", {
      name: "  alice  ",
      uid: { nodeId: "4096", userId: "1025" }
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.loginName).toBe("alice-login");

    const all = await client.listUsers("user-token", {
      uid: { nodeId: "0", userId: "0" }
    });
    expect(all).toHaveLength(1);
    expect(all[0]?.loginName).toBe("");

    expect(calls).toEqual([
      { method: "GET", path: "/users?name=alice&uid=4096%3A1025" },
      { method: "GET", path: "/users" }
    ]);
  });

  it("rejects half-empty uid filters for listUsers", async () => {
    const client = new HTTPClient("http://127.0.0.1:8080", {
      fetch: async () => {
        throw new Error("fetch should not be called");
      }
    });

    await expect(client.listUsers("user-token", {
      uid: { nodeId: "4096", userId: "0" }
    })).rejects.toThrow("request.uid must provide both nodeId and userId together");
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
