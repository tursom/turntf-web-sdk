import { describe, expect, it, vi } from "vitest";
import { TurntfWebClient } from "./index";
import type { FetchLike } from "./types";

function createMessage(seq: number) {
  return {
    recipient: { node_id: 1, user_id: 2 },
    node_id: 1,
    seq,
    sender: { node_id: 1, user_id: 2 },
    body: [104, 105],
    created_at: `1710000000000000000-${seq}`,
  };
}

describe("TurntfWebClient", () => {
  it("sends login ids as numbers", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      return new Response(
        JSON.stringify({
          token: "token",
          expires_at: "never",
          user: { node_id: "1", user_id: "2", username: "alice", role: "user" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const client = new TurntfWebClient({ baseUrl: "/api", fetch: fetchMock });
    await client.loginWithPassword("1", "2", "secret");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.body).toBe(JSON.stringify({ node_id: 1, user_id: 2, password: "secret" }));
  });

  it("emits snapshot first and only pushes newer message deltas", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [createMessage(1), createMessage(2)] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [createMessage(1), createMessage(2), createMessage(3)] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

    const snapshotSpy = vi.fn();
    const deltaSpy = vi.fn();
    const client = new TurntfWebClient({ baseUrl: "/api", fetch: fetchMock as FetchLike });
    const watcher = client.watchMessagesByUser("token", 1, 2, {
      intervalMs: 60_000,
      onSnapshot: snapshotSpy,
      onMessages: deltaSpy,
    });

    await vi.waitFor(() => {
      expect(snapshotSpy).toHaveBeenCalledTimes(1);
    });

    await watcher.refresh();
    watcher.stop();

    expect(snapshotSpy).toHaveBeenCalledWith([createMessage(1), createMessage(2)]);
    expect(deltaSpy).toHaveBeenCalledTimes(1);
    expect(deltaSpy).toHaveBeenCalledWith([createMessage(3)], [createMessage(1), createMessage(2), createMessage(3)]);
  });
});
