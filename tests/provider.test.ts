import { afterEach, describe, expect, test, mock } from "bun:test";

import { BitbucketProvider } from "../src/provider.js";

function setupMockFetch(
  handler: (url: string) => { status?: number; body?: unknown },
) {
  const original = globalThis.fetch;
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const r = handler(url);
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const stubHost = {
  storage: {
    get: async () => null,
    set: async () => {},
    delete: async () => true,
  },
} as never;

describe("BitbucketProvider", () => {
  let restore = () => {};
  afterEach(() => restore());

  test("validates via /user", async () => {
    restore = setupMockFetch((url) => {
      if (url.endsWith("/user")) return { body: { username: "vignesh" } };
      return { body: {} };
    });
    const p = new BitbucketProvider(stubHost);
    await p.saveCredentials({ kind: "pat", token: "vignesh:abc123" });
    const v = await p.validateCredentials();
    expect(v.ok).toBe(true);
    expect(v.account).toBe("vignesh");
  });

  test("honours meta.baseUrl override (self-hosted / replay)", async () => {
    const seen: string[] = [];
    restore = setupMockFetch((url) => {
      seen.push(url);
      if (url.endsWith("/user")) return { body: { username: "vignesh" } };
      return { body: {} };
    });
    const p = new BitbucketProvider(stubHost);
    await p.saveCredentials({
      kind: "pat",
      token: "vignesh:abc",
      meta: { baseUrl: "http://localhost:8771/2.0" },
    });
    await p.validateCredentials();
    expect(seen.some((u) => u.startsWith("http://localhost:8771/2.0/user"))).toBe(true);
    expect(seen.some((u) => u.startsWith("https://api.bitbucket.org"))).toBe(false);
  });

  test("listRepos maps values[]", async () => {
    restore = setupMockFetch(() => ({
      body: {
        values: [
          {
            full_name: "vignesh/example",
            is_private: false,
            mainbranch: { name: "main" },
            language: "TypeScript",
            links: { html: { href: "https://bitbucket.org/vignesh/example" } },
            created_on: "2026-01-01T00:00:00Z",
            updated_on: "2026-05-20T00:00:00Z",
          },
        ],
      },
    }));
    const p = new BitbucketProvider(stubHost);
    await p.saveCredentials({ kind: "pat", token: "vignesh:abc" });
    const page = await p.listRepos({ org: "vignesh", limit: 5 });
    expect(page.items[0]?.fqn).toBe("vignesh/example");
    expect(page.items[0]?.provider).toBe("bitbucket");
    expect(page.items[0]?.visibility).toBe("public");
  });
});
