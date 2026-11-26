import { describe, it, expect, vi, beforeEach } from "vitest";

const send = vi.fn();
vi.mock("../db.js", () => ({
  docClient: { send: (cmd: unknown) => send(cmd) },
  tableName: "test-table",
}));

import { consumeRateLimit } from "../ratelimit.js";

describe("consumeRateLimit", () => {
  beforeEach(() => send.mockReset());

  it("allows while the counter is at or under the limit", async () => {
    send.mockResolvedValue({ Attributes: { count: 3 } });
    const r = await consumeRateLimit("anon-store:198.51.100.7", 3, 3600, 1_700_000_000_000);
    expect(r).toMatchObject({ allowed: true, count: 3, limit: 3 });
    expect(r.resetInSeconds).toBeGreaterThan(0);
    expect(r.resetInSeconds).toBeLessThanOrEqual(3600);
  });

  it("denies once the counter passes the limit", async () => {
    send.mockResolvedValue({ Attributes: { count: 4 } });
    const r = await consumeRateLimit("anon-store:198.51.100.7", 3, 3600);
    expect(r.allowed).toBe(false);
  });

  it("keys the item by window bucket and sets a TTL past the window", async () => {
    send.mockResolvedValue({ Attributes: { count: 1 } });
    const now = 1_700_000_000_000;
    await consumeRateLimit("k", 10, 3600, now);
    const input = send.mock.calls[0][0].input;
    const bucket = Math.floor(now / 1000 / 3600);
    expect(input.TableName).toBe("test-table");
    expect(input.Key).toEqual({ pk: `ratelimit#k#${bucket}`, sk: "ratelimit" });
    expect(input.ExpressionAttributeValues[":ttl"]).toBe((bucket + 2) * 3600);
  });

  it("treats a missing count as the first hit", async () => {
    send.mockResolvedValue({});
    const r = await consumeRateLimit("k", 1, 60);
    expect(r).toMatchObject({ allowed: true, count: 1 });
  });
});
