# 开发环境与构建指南

## 前置要求

- **Node.js** >= 20（参见 `package.json` 的 `engines` 字段）。
- **npm**（随 Node.js 一起安装）。
- **protoc**（Protocol Buffers 编译器，仅在修改 proto 时需要）。
- 推荐使用 VSCode 作为编辑器，配合 TypeScript 插件获得最佳开发体验。

## 环境搭建

```bash
# 克隆仓库
git clone <仓库地址>
cd turntf-web-sdk

# 安装依赖
npm install
```

依赖项说明：

### 运行时依赖

| 包名 | 用途 |
|------|------|
| `@protobuf-ts/runtime` | Protobuf 运行时，用于消息序列化/反序列化 |
| `bcryptjs` | 浏览器兼容的 bcrypt 密码哈希实现 |
| `json-bigint` | 支持 64 位整数的 JSON 解析/序列化 |

### 开发依赖

| 包名 | 用途 |
|------|------|
| `@protobuf-ts/plugin` | Protobuf TypeScript 代码生成插件 |
| `typescript` | TypeScript 编译器 |
| `vitest` | 测试框架 |
| `ws` 和 `@types/ws` | 测试中使用的 WebSocket 实现（非浏览器环境需要） |
| `@types/node` | Node.js 类型定义 |

## 可用命令

```bash
npm run gen:proto    # 从 proto 生成 TypeScript 代码
npm run typecheck    # 类型检查（tsc --noEmit）
npm run build        # 构建到 dist/ 目录
npm test             # 运行单元测试
npm run pack:check   # 检查发布内容清单
```

## 构建流程

构建使用 `tsconfig.build.json`，它继承 `tsconfig.json` 并设置：

- `noEmit: false` — 允许输出文件。
- `rootDir: "./src"` — 源代码根目录。
- 仅包含 `src/**/*.ts`（排除测试文件）。

```bash
npm run build
```

构建产物输出到 `dist/` 目录，包含：

- `dist/index.js` — 主入口文件。
- `dist/index.d.ts` — 类型声明文件。
- `dist/**/*.d.ts` — 各模块的类型声明文件。

## 测试

测试使用 Vitest 框架，测试文件位于 `test/` 目录：

```bash
# 运行所有测试
npm test

# 以 watch 模式运行
npx vitest

# 运行特定测试文件
npx vitest test/client.test.ts

# 运行测试并生成覆盖率报告
npx vitest run --coverage
```

### 测试策略

- **HTTPClient 测试**：通过注入 mock `fetch` 实现，验证请求构建和响应解析。
- **Client 测试**：通过模拟 `globalThis.WebSocket` 实现，验证连接握手、消息收发、重连逻辑。
- **冒烟测试**：端到端的基本功能验证。

## Proto 生成

### 首次设置

1. 安装 Protocol Buffers 编译器：
   ```bash
   # macOS
   brew install protobuf

   # Ubuntu/Debian
   apt install protobuf-compiler

   # Windows (Chocolatey)
   choco install protoc
   ```

2. 确保 `protoc` 命令可在终端中访问：
   ```bash
   protoc --version
   ```

### 生成命令

```bash
npm run gen:proto
```

此命令会：

1. 调用 `protoc` 处理 `proto/client.proto`，使用 `@protobuf-ts/plugin` 生成 TypeScript 代码。
2. 输出到 `src/generated/client.ts`。
3. 运行 `scripts/postprocess-generated.mjs` 后处理脚本，添加 TypeScript `override` 关键字并修复可选链问题。

### 后处理脚本说明

`scripts/postprocess-generated.mjs` 对生成的代码做三件事：

- 在 `create()` 方法前添加 `override`。
- 在 `internalBinaryRead()` 方法前添加 `override`。
- 在 `internalBinaryWrite()` 方法前添加 `override`。
- 将形如 `message.foo[i]` 的访问修正为 `message.foo[i]!`（非空断言）。

这是因为 `@protobuf-ts/plugin` 生成的代码使用了 TypeScript 的 `override` 关键字，但生成逻辑不总是自动添加。

**注意**：生成的 `src/generated/client.ts` 已提交到版本控制中。修改 `proto/client.proto` 后，务必：

1. 重新生成代码。
2. 验证生成结果是否正常（`npm run typecheck`）。
3. 提交 `src/generated/client.ts` 的变更。

## 发布流程

### 发布前检查

```bash
# 1. 类型检查
npm run typecheck

# 2. 运行测试
npm test

# 3. 构建
npm run build

# 4. 检查发布内容
npm run pack:check
```

四个检查步骤已整合在 `prepublishOnly` 脚本中，在 `npm publish` 时自动执行。

### 发布命令

```bash
# 补丁版本
npm version patch
npm publish

# 次版本
npm version minor
npm publish

# 主版本
npm version major
npm publish
```

发布配置：
- 注册表：`https://registry.npmjs.org/`（npm 官方公共注册表）。
- 访问权限：`public`（因为 `@tursom` 作用域需要公开包）。
- 发布内容：`dist/`、`proto/`、`README.md`。

### 版本历史

| 版本 | 说明 |
|------|------|
| 0.1.x | 初始版本，含 `TurntfWebClient` 和轮询订阅 |
| 0.2.0 | 重大重构：移除旧 API，切换为 `HTTPClient` / `Client` 架构 |
| 0.2.1 | 当前版本，修复和优化 |

## 项目结构总览

```
turntf-web-sdk/
├── proto/
│   └── client.proto            # Protocol Buffers 协议定义
├── scripts/
│   └── postprocess-generated.mjs  # Proto 生成代码的后处理
├── src/
│   ├── index.ts                # 入口，重导出所有模块
│   ├── client.ts               # WebSocket 长连接客户端
│   ├── http.ts                 # HTTP JSON 客户端
│   ├── types.ts                # 公共类型定义
│   ├── errors.ts               # 错误类型
│   ├── password.ts             # 密码处理
│   ├── mapping.ts              # Proto ↔ SDK 类型转换
│   ├── store.ts                # 游标存储抽象
│   ├── utils.ts                # 工具函数
│   ├── validation.ts           # 输入校验
│   └── generated/
│       └── client.ts           # 由 proto 生成的代码
├── test/
│   ├── client.test.ts          # Client 测试
│   ├── http.test.ts            # HTTPClient 测试
│   └── smoke.test.ts           # 冒烟测试
├── dist/                       # 构建输出
├── AGENTS.md                   # AI 助手指南
├── docs/                       # 文档目录
│   ├── sdk-guide.md            # SDK 使用指南
│   ├── client-flow.md          # WebSocket 客户端流程
│   └── development.md          # 开发环境指南
├── package.json
├── tsconfig.json
├── tsconfig.build.json
└── README.md
```

## 常见问题

### Q: 浏览器中报 `WebSocket is not defined`？

A: 本 SDK 依赖浏览器原生 `WebSocket`（通过 `globalThis.WebSocket` 访问）。确保运行环境是浏览器，或已在 polyfill 中提供了 `WebSocket`。

### Q: 如何在不同页面/标签页间保持连接？

A: 每个 `Client` 实例对应一个独立的 WebSocket 连接。如果需要在多标签页间共享连接，可以考虑使用 `SharedWorker` 并在 Worker 中维护 `Client` 实例。

### Q: `MemoryCursorStore` 是否适用于生产环境？

A: `MemoryCursorStore` 仅将游标保存在内存中，页面刷新后会丢失。生产环境建议实现 `CursorStore` 接口并使用 IndexedDB 持久化，确保断线重连后能正确恢复已确认的消息游标。

### Q: 能否在 Service Worker 中使用？

A: 可以，但需要注意 Service Worker 中的 `globalThis` 与主线程不同。`Client` 使用了 `globalThis.fetch` 和 `globalThis.WebSocket`，在 Service Worker 中这两个 API 都可用。
