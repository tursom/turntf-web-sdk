export type IdLike = number | string;

export type MessageBodyInput =
  | string
  | ArrayBuffer
  | ArrayLike<number>
  | ArrayBufferView;

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface UserRef {
  node_id: number;
  user_id: number;
}

export interface Message {
  recipient: UserRef;
  node_id: number;
  seq: number;
  sender: UserRef;
  body: number[];
  created_at: string;
}

export interface LoginUser {
  node_id: string;
  user_id: string;
  username: string;
  role: string;
}

export interface LoginResponse {
  token: string;
  expires_at: string;
  user: LoginUser;
}

export interface TurntfWebClientOptions {
  baseUrl?: string;
  fetch?: FetchLike;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface ListMessagesByUserOptions extends RequestOptions {
  limit?: number;
}

export interface WatchMessagesByUserOptions extends ListMessagesByUserOptions {
  intervalMs?: number;
  onSnapshot?: (messages: Message[]) => void | Promise<void>;
  onMessages?: (messages: Message[], snapshot: Message[]) => void | Promise<void>;
  onError?: (error: Error) => void | Promise<void>;
}

export interface MessageWatcher {
  refresh(): Promise<void>;
  stop(): void;
}
