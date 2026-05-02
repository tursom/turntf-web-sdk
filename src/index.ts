/**
 * turntf-web-sdk - turntf 即时通讯服务的 Web SDK。
 *
 * 提供基于 WebSocket 的实时通信客户端（{@link Client}）和
 * 基于 HTTP 的 REST API 客户端（{@link HTTPClient}）。
 *
 * 主要功能：
 * - 用户认证（登录名或 nodeId+userId）
 * - 消息收发（持久化消息和瞬时数据包）
 * - 频道订阅管理
 * - 用户元数据管理
 * - 黑名单管理
 * - 集群节点监控
 * - 自动重连、心跳保活、消息确认
 *
 * @example
 * const { Client, plainPassword } = require("turntf-web-sdk");
 *
 * const client = new Client({
 *   baseUrl: "https://turntf.example.com",
 *   credentials: { loginName: "user", password: await plainPassword("pass") },
 *   handler: {
 *     onMessage(msg) { console.log("收到消息:", msg); }
 *   }
 * });
 * await client.connect();
 */

export * from "./client";
export * from "./errors";
export * from "./http";
export * from "./mapping";
export * from "./password";
export * from "./relay";
export * from "./store";
export * from "./types";
export * from "./utils";
export * from "./validation";
export * as proto from "./generated/client";
