# turntf-web-sdk

`turntf-web-sdk` 是一个面向浏览器环境的 turntf SDK，当前优先覆盖 `turntf-web` 已经在使用的能力：

- 基于 `fetch` 的 HTTP 登录
- 历史消息查询
- 发送持久消息
- 浏览器友好的消息轮询订阅

当前实现刻意不复用 `turntf-js`，因为 `turntf-js` 面向 Node.js 20+，并依赖 `ws` 等浏览器环境不可直接使用的能力。

## 设计原则

- 只依赖浏览器原生能力，不引入 Node 运行时依赖
- 暴露稳定的 JSON/消息类型，方便 React 等前端直接消费
- 将“轮询增量判断”收口到 SDK，而不是散落在页面组件里

## 当前范围

当前包只覆盖 turntf-web 的聊天主链路。后续如果要扩展为完整浏览器 SDK，可以继续补：

- 其他 HTTP JSON 管理接口
- `WebSocket + protobuf` 实时能力
- 自动重连、`session_ref`、`ack`、瞬时包等高级协议语义

## 本地开发

```bash
npm install
npm run typecheck
npm test
```
