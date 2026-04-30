import type {
  FetchLike,
  IdLike,
  ListMessagesByUserOptions,
  LoginResponse,
  Message,
  MessageBodyInput,
  MessageWatcher,
  RequestOptions,
  TurntfWebClientOptions,
  WatchMessagesByUserOptions,
} from "./types";

function missingFetch(): never {
  throw new Error("当前环境缺少 fetch，实现 turntf-web-sdk 需要浏览器原生 fetch 或手动注入 fetch");
}

function defaultFetchImpl(): FetchLike {
  if (typeof fetch !== "function") {
    return missingFetch;
  }
  return fetch.bind(globalThis) as FetchLike;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function parseId(name: string, value: IdLike): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} 必须是非负整数，收到: ${value}`);
  }
  return parsed;
}

function toUint8Array(input: MessageBodyInput): Uint8Array {
  if (typeof input === "string") {
    return new TextEncoder().encode(input);
  }
  if (input instanceof Uint8Array) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return Uint8Array.from(input);
}

export function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function decodeBytes(bytes: Uint8Array | number[] | null | undefined): string {
  if (!bytes || bytes.length === 0) {
    return "";
  }
  const value = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return `[二进制数据: ${value.length} bytes]`;
  }
}

export class TurntfWebError extends Error {
  readonly status: number;
  readonly responseText: string;

  constructor(status: number, responseText: string) {
    super(responseText || `HTTP ${status}`);
    this.name = "TurntfWebError";
    this.status = status;
    this.responseText = responseText;
  }
}

export class TurntfWebClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: TurntfWebClientOptions = {}) {
    this.baseUrl = trimTrailingSlash(options.baseUrl ?? "/api");
    this.fetchImpl = options.fetch ?? defaultFetchImpl();
  }

  async loginWithPassword(
    nodeId: IdLike,
    userId: IdLike,
    password: string,
    options: RequestOptions = {}
  ): Promise<LoginResponse> {
    return this.requestJson<LoginResponse>("/auth/login", {
      method: "POST",
      signal: options.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        node_id: parseId("nodeId", nodeId),
        user_id: parseId("userId", userId),
        password,
      }),
    });
  }

  async listMessagesByUser(
    token: string,
    nodeId: IdLike,
    userId: IdLike,
    options: ListMessagesByUserOptions = {}
  ): Promise<Message[]> {
    const limit = options.limit ?? 50;
    const path = `/nodes/${parseId("nodeId", nodeId)}/users/${parseId("userId", userId)}/messages?limit=${limit}`;
    const response = await this.requestJson<{ items?: Message[] }>(path, {
      signal: options.signal,
      headers: this.authHeaders(token),
    });
    return response.items ?? [];
  }

  async sendMessage(
    token: string,
    nodeId: IdLike,
    userId: IdLike,
    body: MessageBodyInput,
    options: RequestOptions = {}
  ): Promise<Message> {
    const bytes = toUint8Array(body);
    return this.requestJson<Message>(
      `/nodes/${parseId("nodeId", nodeId)}/users/${parseId("userId", userId)}/messages`,
      {
        method: "POST",
        signal: options.signal,
        headers: this.authHeaders(token),
        body: JSON.stringify({ body: Array.from(bytes) }),
      }
    );
  }

  watchMessagesByUser(
    token: string,
    nodeId: IdLike,
    userId: IdLike,
    options: WatchMessagesByUserOptions = {}
  ): MessageWatcher {
    const intervalMs = options.intervalMs ?? 3000;
    let active = true;
    let initialized = false;
    let lastSeq = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: Promise<void> | null = null;

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const stop = () => {
      active = false;
      clearTimer();
      options.signal?.removeEventListener("abort", stop);
    };

    const schedule = () => {
      if (!active || intervalMs <= 0) {
        return;
      }
      clearTimer();
      timer = setTimeout(() => {
        void refresh();
      }, intervalMs);
    };

    const runPoll = async () => {
      const snapshot = await this.listMessagesByUser(token, nodeId, userId, options);
      if (!active) {
        return;
      }

      const latestSeq = snapshot.length > 0 ? snapshot[snapshot.length - 1]!.seq : lastSeq;
      if (!initialized) {
        initialized = true;
        lastSeq = latestSeq;
        await options.onSnapshot?.(snapshot);
        return;
      }

      const delta = snapshot.filter((message) => message.seq > lastSeq);
      lastSeq = latestSeq;
      if (delta.length > 0) {
        await options.onMessages?.(delta, snapshot);
      }
    };

    const normalizeError = (error: unknown): Error => {
      if (error instanceof Error) {
        return error;
      }
      return new Error(String(error));
    };

    const refresh = async (): Promise<void> => {
      if (!active) {
        return;
      }
      clearTimer();
      if (inFlight) {
        return inFlight;
      }

      inFlight = (async () => {
        try {
          await runPoll();
        } catch (error) {
          if (active) {
            await options.onError?.(normalizeError(error));
          }
        } finally {
          inFlight = null;
          schedule();
        }
      })();

      return inFlight;
    };

    if (options.signal?.aborted) {
      stop();
      return { refresh: async () => {}, stop };
    }

    options.signal?.addEventListener("abort", stop, { once: true });
    void refresh();

    return { refresh, stop };
  }

  private authHeaders(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
  }

  private async requestJson<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    if (!response.ok) {
      throw new TurntfWebError(response.status, await response.text());
    }
    return (await response.json()) as T;
  }
}
