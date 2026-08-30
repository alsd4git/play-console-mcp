import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOAuthTokenProvider,
  parseOAuthClientConfig,
  readOAuthTokenRecord,
  writeOAuthTokenRecord,
  type OAuthTokenRecord,
} from "../play/oauth.js";

function tokenRecord(overrides: Partial<OAuthTokenRecord> = {}): OAuthTokenRecord {
  return {
    version: 1,
    clientId: "client-id.apps.googleusercontent.com",
    clientSecret: "client-secret",
    refreshToken: "refresh-token",
    scopes: ["scope-a"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("Google user OAuth", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => vi.restoreAllMocks());

  it("parses Google's installed-app client JSON", () => {
    expect(
      parseOAuthClientConfig(
        JSON.stringify({
          installed: {
            client_id: "desktop.apps.googleusercontent.com",
            client_secret: "secret",
            redirect_uris: ["http://localhost"],
          },
        }),
      ),
    ).toEqual({
      clientId: "desktop.apps.googleusercontent.com",
      clientSecret: "secret",
      redirectUris: ["http://localhost"],
      clientType: "installed",
    });
  });

  it("rejects malformed client JSON", () => {
    expect(() => parseOAuthClientConfig("not-json")).toThrow("not valid JSON");
    expect(() => parseOAuthClientConfig(JSON.stringify({ project_id: "x" }))).toThrow(
      "must contain an 'installed' or 'web' OAuth client",
    );
  });

  it("writes and reads a protected token record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "play-console-oauth-"));
    const path = join(directory, "nested", "token.json");
    const record = tokenRecord();
    await writeOAuthTokenRecord(record, path);

    expect(await readOAuthTokenRecord(path)).toEqual(record);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(record);
  });

  it("returns a cached access token while it is fresh", async () => {
    const directory = await mkdtemp(join(tmpdir(), "play-console-oauth-"));
    const path = join(directory, "token.json");
    await writeOAuthTokenRecord(
      tokenRecord({ accessToken: "cached", expiresAt: 2_000_000 }),
      path,
    );

    const provider = createOAuthTokenProvider({ tokenPath: path }, () => 1_000_000);
    await expect(provider()).resolves.toBe("cached");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("refreshes and persists an expired access token", async () => {
    const directory = await mkdtemp(join(tmpdir(), "play-console-oauth-"));
    const path = join(directory, "token.json");
    await writeOAuthTokenRecord(
      tokenRecord({ accessToken: "expired", expiresAt: 900_000 }),
      path,
    );
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: () =>
        Promise.resolve(
          JSON.stringify({
            access_token: "refreshed",
            expires_in: 3600,
            scope: "scope-a scope-b",
            token_type: "Bearer",
          }),
        ),
    });

    const provider = createOAuthTokenProvider({ tokenPath: path }, () => 1_000_000);
    await expect(provider()).resolves.toBe("refreshed");
    await expect(provider()).resolves.toBe("refreshed");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const params = new URLSearchParams(mockFetch.mock.calls[0][1].body as URLSearchParams);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("client_id")).toBe("client-id.apps.googleusercontent.com");
    expect(params.get("client_secret")).toBe("client-secret");
    expect(params.get("refresh_token")).toBe("refresh-token");

    const persisted = await readOAuthTokenRecord(path);
    expect(persisted.accessToken).toBe("refreshed");
    expect(persisted.scopes).toEqual(["scope-a", "scope-b"]);
  });

  it("reports token endpoint errors without discarding the refresh token", async () => {
    const directory = await mkdtemp(join(tmpdir(), "play-console-oauth-"));
    const path = join(directory, "token.json");
    const record = tokenRecord();
    await writeOAuthTokenRecord(record, path);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: () =>
        Promise.resolve(
          JSON.stringify({ error: "invalid_grant", error_description: "revoked" }),
        ),
    });

    const provider = createOAuthTokenProvider({ tokenPath: path });
    await expect(provider()).rejects.toThrow("invalid_grant");
    expect((await readOAuthTokenRecord(path)).refreshToken).toBe("refresh-token");
  });
});
