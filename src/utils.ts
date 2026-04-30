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

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

export function parseJson(text: string): unknown {
  return json.parse(text);
}

export function stringifyJson(value: unknown): string {
  return json.stringify(value);
}

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

export function utf8ToBytes(value: string): Uint8Array {
  return new Uint8Array(textEncoder.encode(value));
}

export function bytesToUtf8(value: Uint8Array): string {
  return textDecoder.decode(value);
}

export function cloneBytes(value: Uint8Array | undefined): Uint8Array {
  return value == null ? new Uint8Array(0) : new Uint8Array(value);
}

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

export function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new Error("operation aborted");
}

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

export async function readResponseText(response: Response): Promise<string> {
  return response.text();
}

export function ensureConnectionError(op: string, cause: unknown): ConnectionError {
  return cause instanceof ConnectionError ? cause : new ConnectionError(op, cause);
}
