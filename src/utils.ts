import JSONBig from "json-bigint";

import { ConnectionError } from "./errors";
import type { RequestOptions } from "./types";

const json = JSONBig({
  storeAsString: true,
  useNativeBigInt: true,
  protoAction: "ignore",
  constructorAction: "ignore"
});

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * 延迟结果接口。
 * 提供 Promise 及其 resolve/reject 方法的引用。
 * 用于在异步操作完成后手动控制 Promise 的完成状态。
 *
 * @template T 返回值的类型
 */
export interface Deferred<T> {
  /** 关联的 Promise 对象 */
  promise: Promise<T>;
  /** 手动完成 Promise 并设置返回值 */
  resolve(value: T | PromiseLike<T>): void;
  /** 手动拒绝 Promise 并设置错误原因 */
  reject(reason?: unknown): void;
}

/**
 * 创建一个 {@link Deferred} 实例，用于手动控制 Promise 的完成和拒绝。
 *
 * @template T 返回值的类型
 * @returns Deferred 实例，包含 promise、resolve 和 reject
 *
 * @example
 * const deferred = createDeferred<string>();
 * deferred.resolve("done");
 * await deferred.promise; // "done"
 */
export function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

/**
 * 将 JSON 字符串解析为 JavaScript 对象。
 * 使用 json-bigint 库解析，支持大整数（BigInt）类型的自动转换。
 *
 * @param text - 待解析的 JSON 字符串
 * @returns 解析后的对象
 *
 * @example
 * const obj = parseJson('{"id":12345678901234567890}');
 */
export function parseJson(text: string): unknown {
  return json.parse(text);
}

/**
 * 将 JavaScript 对象序列化为 JSON 字符串。
 * 使用 json-bigint 库序列化，支持 BigInt 类型。
 *
 * @param value - 待序列化的值
 * @returns JSON 字符串
 *
 * @example
 * const text = stringifyJson({ name: "test", big: BigInt("123") });
 */
export function stringifyJson(value: unknown): string {
  return json.stringify(value);
}

/**
 * 将 Uint8Array 字节数组编码为 Base64 字符串。
 *
 * @param bytes - 字节数组
 * @returns Base64 编码的字符串
 * @throws 如果当前环境不支持 btoa 则抛出错误
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const btoaImpl = globalThis.btoa;
  if (typeof btoaImpl !== "function") {
    throw new Error("base64 encoding is not available in the current environment");
  }

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoaImpl(binary);
}

/**
 * 将 Base64 字符串解码为 Uint8Array 字节数组。
 *
 * @param value - Base64 编码的字符串
 * @returns 解码后的字节数组
 * @throws 如果当前环境不支持 atob 则抛出错误
 */
export function base64ToBytes(value: string): Uint8Array {
  if (value === "") {
    return new Uint8Array(0);
  }

  const atobImpl = globalThis.atob;
  if (typeof atobImpl !== "function") {
    throw new Error("base64 decoding is not available in the current environment");
  }

  const binary = atobImpl(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * 将 UTF-8 字符串编码为 Uint8Array 字节数组。
 *
 * @param value - UTF-8 字符串
 * @returns 编码后的字节数组
 *
 * @example
 * const bytes = utf8ToBytes("你好");
 */
export function utf8ToBytes(value: string): Uint8Array {
  return new Uint8Array(textEncoder.encode(value));
}

/**
 * 将 Uint8Array 字节数组解码为 UTF-8 字符串。
 *
 * @param value - 字节数组
 * @returns 解码后的 UTF-8 字符串
 *
 * @example
 * const text = bytesToUtf8(new Uint8Array([228, 189, 160, 229, 165, 189]));
 */
export function bytesToUtf8(value: Uint8Array): string {
  return textDecoder.decode(value);
}

/**
 * 克隆 Uint8Array 字节数组。
 * 如果传入 undefined 或 null，则返回一个空数组。
 *
 * @param value - 待克隆的字节数组（可选）
 * @returns 克隆后的新 Uint8Array 实例
 */
export function cloneBytes(value: Uint8Array | undefined): Uint8Array {
  return value == null ? new Uint8Array(0) : new Uint8Array(value);
}

/**
 * 等待指定的毫秒数。
 * 支持通过 AbortSignal 提前取消等待。
 *
 * @param ms - 等待的毫秒数
 * @param signal - 可选的取消信号，当信号被中止时 Promise 将立即被拒绝
 * @returns 等待完成后 resolve，取消时 reject
 *
 * @example
 * await sleep(1000); // 等待 1 秒
 * await sleep(1000, abortSignal); // 可被取消的等待
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };

    if (signal) {
      if (signal.aborted) {
        cleanup();
        reject(abortReason(signal));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * 获取 AbortSignal 的中止原因。
 * 如果信号被中止，返回其 reason；否则返回通用 "operation aborted" 错误。
 *
 * @param signal - 可选的 AbortSignal
 * @returns 中止原因
 */
export function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new Error("operation aborted");
}

/**
 * 合并多个中止信号和一个可选的超时时间。
 * 创建一个新的 AbortController，当任一输入信号被中止或超时到达时，
 * 新控制器也会被中止。
 *
 * @param options - 包含可选的 signal 和 timeoutMs 的配置
 * @returns 包含合并后的 signal 和清理函数的对象
 *
 * @example
 * const { signal, cleanup } = mergeAbortSignals({ timeoutMs: 5000 });
 * try {
 *   await fetch(url, { signal });
 * } finally {
 *   cleanup();
 * }
 */
export function mergeAbortSignals(options?: RequestOptions): {
  signal: AbortSignal;
  cleanup(): void;
} {
  const controller = new AbortController();
  const { signal, timeoutMs } = options ?? {};
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const onAbort = () => {
    controller.abort(abortReason(signal));
  };

  if (signal) {
    if (signal.aborted) {
      controller.abort(abortReason(signal));
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  if (timeoutMs != null && timeoutMs > 0) {
    timeout = setTimeout(() => {
      controller.abort(new Error(`operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    cleanup() {
      if (timeout) {
        clearTimeout(timeout);
      }
      signal?.removeEventListener("abort", onAbort);
    }
  };
}

/**
 * 读取 HTTP Response 对象的文本内容。
 *
 * @param response - Fetch API 的 Response 对象
 * @returns 响应体的文本内容
 */
export async function readResponseText(response: Response): Promise<string> {
  return response.text();
}

/**
 * 确保错误是 ConnectionError 类型。
 * 如果已是 ConnectionError 则直接返回，否则包装为新的 ConnectionError。
 *
 * @param op - 发生错误时的操作名称
 * @param cause - 原始错误
 * @returns ConnectionError 实例
 */
export function ensureConnectionError(op: string, cause: unknown): ConnectionError {
  return cause instanceof ConnectionError ? cause : new ConnectionError(op, cause);
}
