import { describe, it, expect, vi, afterEach } from "vitest";
import { metrics, withMetrics } from "../powertools.js";

describe("withMetrics", () => {
  afterEach(() => vi.restoreAllMocks());

  it("publishes buffered metrics after the handler resolves", async () => {
    const publish = vi.spyOn(metrics, "publishStoredMetrics").mockImplementation(() => {});
    const handler = withMetrics(async (n: number) => n * 2);

    await expect(handler(21)).resolves.toBe(42);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("still publishes when the handler throws", async () => {
    const publish = vi.spyOn(metrics, "publishStoredMetrics").mockImplementation(() => {});
    const handler = withMetrics(async () => {
      throw new Error("boom");
    });

    await expect(handler(undefined)).rejects.toThrow("boom");
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
