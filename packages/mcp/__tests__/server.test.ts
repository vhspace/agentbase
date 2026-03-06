import { describe, it, expect } from "vitest";
import { generateKeypair } from "../src/auth.js";
import { createMcpServer } from "../src/index.js";

describe("createMcpServer", () => {
  it("creates server without keys (unauthenticated)", () => {
    const server = createMcpServer();
    expect(server).toBeTruthy();
  });

  it("creates server with keys (authenticated)", async () => {
    const { privateKey, publicKey } = await generateKeypair();
    const server = createMcpServer({ privateKey, publicKey });
    expect(server).toBeTruthy();
  });
});
