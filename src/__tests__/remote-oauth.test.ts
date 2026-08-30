import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadRemoteOAuthConfig,
  pkceChallenge,
  remoteSecret,
  validClientRedirectUri,
} from "../remote/config.js";
import { RemoteOAuthStore } from "../remote/store.js";

function webClientFile(directory: string): string {
  const clientPath = join(directory, "client.json");
  writeFileSync(
    clientPath,
    JSON.stringify({
      web: {
        client_id: "web.apps.googleusercontent.com",
        client_secret: "secret",
        redirect_uris: ["https://play-mcp.example.com/oauth/google/callback"],
      },
    }),
  );
  return clientPath;
}

describe("remote OAuth", () => {
  beforeEach(() => {
    vi.stubEnv("MCP_PUBLIC_URL", "https://play-mcp.example.com/mcp");
    vi.stubEnv("MCP_OAUTH_SECRET", "test-secret-that-is-longer-than-thirty-two-characters");
    vi.stubEnv("GOOGLE_OAUTH_ALLOWED_EMAILS", "owner@example.com");
    vi.stubEnv("MCP_OAUTH_ALLOW_ANY_GOOGLE_ACCOUNT", "");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("uses RFC 7636 S256 PKCE", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("accepts HTTPS and loopback redirect URIs only", () => {
    expect(validClientRedirectUri("https://chatgpt.com/aip/callback")).toBe(true);
    expect(validClientRedirectUri("http://127.0.0.1:3000/callback")).toBe(true);
    expect(validClientRedirectUri("http://localhost:3000/callback")).toBe(true);
    expect(validClientRedirectUri("http://example.com/callback")).toBe(false);
    expect(validClientRedirectUri("javascript:alert(1)")).toBe(false);
    expect(validClientRedirectUri("https://example.com/callback#fragment")).toBe(false);
  });

  it("generates high-entropy server secrets", () => {
    const first = remoteSecret();
    const second = remoteSecret();
    expect(first.length).toBeGreaterThanOrEqual(64);
    expect(second).not.toBe(first);
  });

  it("loads a Web OAuth client and keeps remote access closed to the email allowlist", async () => {
    const directory = mkdtempSync(join(tmpdir(), "play-console-remote-"));
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_CONFIG_PATH", webClientFile(directory));

    const config = await loadRemoteOAuthConfig();
    expect(config.resource.toString()).toBe("https://play-mcp.example.com/mcp");
    expect(config.googleClient.clientType).toBe("web");
    expect(config.allowedEmails.has("owner@example.com")).toBe(true);
    expect(config.allowAnyGoogleAccount).toBe(false);
  });

  it("rejects remote startup when no Google account allowlist is configured", async () => {
    const directory = mkdtempSync(join(tmpdir(), "play-console-remote-"));
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_CONFIG_PATH", webClientFile(directory));
    vi.stubEnv("GOOGLE_OAUTH_ALLOWED_EMAILS", "");

    await expect(loadRemoteOAuthConfig()).rejects.toThrow("Remote OAuth is closed by default");
  });

  it("rejects an OAuth issuer with a nested path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "play-console-remote-"));
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_CONFIG_PATH", webClientFile(directory));
    vi.stubEnv("MCP_OAUTH_ISSUER", "https://play-mcp.example.com/oauth");

    await expect(loadRemoteOAuthConfig()).rejects.toThrow("must be an origin only");
  });

  it("rejects a Desktop OAuth client in remote mode", async () => {
    const directory = mkdtempSync(join(tmpdir(), "play-console-remote-"));
    const clientPath = join(directory, "client.json");
    writeFileSync(
      clientPath,
      JSON.stringify({
        installed: {
          client_id: "desktop.apps.googleusercontent.com",
          client_secret: "secret",
          redirect_uris: ["http://127.0.0.1"],
        },
      }),
    );
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_CONFIG_PATH", clientPath);

    await expect(loadRemoteOAuthConfig()).rejects.toThrow("requires a Google Web OAuth client");
  });

  it("encrypts Google refresh tokens before persisting them", async () => {
    const directory = mkdtempSync(join(tmpdir(), "play-console-store-"));
    const storePath = join(directory, "remote-oauth.json");
    const store = new RemoteOAuthStore(
      storePath,
      "another-test-secret-that-is-longer-than-thirty-two-characters",
    );

    await store.upsertGoogleUser({
      subject: "google-subject-1",
      email: "owner@example.com",
      refreshToken: "google-refresh-token-plaintext",
      googleScopes: ["androidpublisher"],
    });

    expect(await store.googleRefreshToken("google-subject-1")).toBe(
      "google-refresh-token-plaintext",
    );
    expect(readFileSync(storePath, "utf8")).not.toContain("google-refresh-token-plaintext");
  });

  it("bounds persisted dynamic client registrations", async () => {
    const directory = mkdtempSync(join(tmpdir(), "play-console-store-"));
    const store = new RemoteOAuthStore(
      join(directory, "remote-oauth.json"),
      "another-test-secret-that-is-longer-than-thirty-two-characters",
    );

    await store.registerClient({ redirectUris: ["https://chatgpt.com/callback"] }, 1);
    await expect(
      store.registerClient({ redirectUris: ["https://example.com/callback"] }, 1),
    ).rejects.toThrow("registration limit reached");
  });
});
