import { describe, it, expect } from "vitest";
// @ts-expect-error plain CommonJS Lambda@Edge handler, no types
import { handler } from "../edgeRestoreWwwAuthenticate.cjs";

type Header = { key?: string; value: string };
type Headers = Record<string, Header[]>;

function event(status: string, headers: Headers) {
  return { Records: [{ cf: { response: { status, statusDescription: "", headers } } }] };
}

describe("edgeRestoreWwwAuthenticate", () => {
  it("copies the remapped header back to WWW-Authenticate on a 401", async () => {
    const res = await handler(
      event("401", {
        "content-type": [{ key: "Content-Type", value: "application/json" }],
        "x-amzn-remapped-www-authenticate": [
          { key: "x-amzn-Remapped-WWW-Authenticate", value: 'Bearer resource_metadata="https://mcp.agentbase.tools/.well-known/oauth-protected-resource"' },
        ],
      }),
    );
    expect(res.headers["www-authenticate"]).toEqual([
      { key: "WWW-Authenticate", value: 'Bearer resource_metadata="https://mcp.agentbase.tools/.well-known/oauth-protected-resource"' },
    ]);
    expect(res.headers["x-amzn-remapped-www-authenticate"]).toBeUndefined();
    expect(res.headers["content-type"]).toEqual([{ key: "Content-Type", value: "application/json" }]);
  });

  it("leaves responses without the remapped header alone", async () => {
    const headers: Headers = { "content-type": [{ key: "Content-Type", value: "text/html" }] };
    const res = await handler(event("200", headers));
    expect(res.headers).toEqual(headers);
    expect(res.status).toBe("200");
  });

  it("does not overwrite an existing WWW-Authenticate", async () => {
    const res = await handler(
      event("401", {
        "www-authenticate": [{ key: "WWW-Authenticate", value: "Bearer realm=x" }],
        "x-amzn-remapped-www-authenticate": [{ key: "x-amzn-Remapped-WWW-Authenticate", value: "Bearer realm=y" }],
      }),
    );
    expect(res.headers["www-authenticate"]).toEqual([{ key: "WWW-Authenticate", value: "Bearer realm=x" }]);
  });
});
