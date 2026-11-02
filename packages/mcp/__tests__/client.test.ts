import { describe, it, expect, vi, afterEach } from "vitest";
import { gql } from "../src/client.js";
import { generateKeypair } from "../src/auth.js";

afterEach(() => vi.restoreAllMocks());

describe("gql authorization", () => {
  it("passes an OAuth access token through as a Bearer header", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: {} }), { status: 200 }),
    );
    await gql({ kind: "bearer", token: "abc.def.ghi" }, "{ me { userId } }");
    const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer abc.def.ghi");
  });

  it("signs a short-lived JWT for a keypair credential", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: {} }), { status: 200 }),
    );
    const { privateKey, publicKey } = await generateKeypair();
    await gql({ kind: "keypair", privateKey, publicKey }, "{ me { userId } }");
    const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization.split(".")).toHaveLength(3);
    expect(headers.Authorization.startsWith("Bearer ")).toBe(false);
  });
});
