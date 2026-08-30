import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("config", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_KEY", "");
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_KEY_PATH", "");
    vi.stubEnv("GOOGLE_PLAY_PACKAGE_NAME", "");
    vi.stubEnv("GOOGLE_PLAY_ALLOW_DESTRUCTIVE", "");
    vi.stubEnv("GOOGLE_PLAY_AUTH_MODE", "auto");
    vi.stubEnv("GOOGLE_OAUTH_TOKEN_PATH", "/tmp/nonexistent-google-oauth.json");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("defaults to user OAuth when no service account key is configured", async () => {
    const { config } = await import("../config.js");
    expect(config.authMode).toBe("oauth");
    expect(config.oauthTokenPath).toBe("/tmp/nonexistent-google-oauth.json");
  });

  it("accepts an inline service account key", async () => {
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_KEY", '{"client_email":"a@b.c","private_key":"k"}');
    const { client, reportingClient } = await import("../config.js");
    expect(client.baseUrl).toContain("androidpublisher.googleapis.com");
    expect(reportingClient.baseUrl).toContain("playdeveloperreporting.googleapis.com");
  });

  it("accepts a key path and an optional default package name", async () => {
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_KEY_PATH", "/tmp/service-account.json");
    vi.stubEnv("GOOGLE_PLAY_PACKAGE_NAME", "com.acme.app");
    const { config } = await import("../config.js");
    expect(config.packageName).toBe("com.acme.app");
    expect(config.authMode).toBe("service-account");
  });

  it("leaves the package name undefined when unset", async () => {
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_KEY_PATH", "/tmp/service-account.json");
    const { config } = await import("../config.js");
    expect(config.packageName).toBeUndefined();
  });

  it("keeps destructive tools disabled unless explicitly opted in", async () => {
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_KEY_PATH", "/tmp/service-account.json");
    const { config } = await import("../config.js");
    expect(config.allowDestructive).toBe(false);
  });

  it("enables destructive tools for 1, true and yes", async () => {
    for (const value of ["1", "true", "TRUE", "yes"]) {
      vi.resetModules();
      vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_KEY_PATH", "/tmp/service-account.json");
      vi.stubEnv("GOOGLE_PLAY_ALLOW_DESTRUCTIVE", value);
      const { config } = await import("../config.js");
      expect(config.allowDestructive).toBe(true);
    }
  });

  it("ignores other values for the destructive flag", async () => {
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_KEY_PATH", "/tmp/service-account.json");
    vi.stubEnv("GOOGLE_PLAY_ALLOW_DESTRUCTIVE", "0");
    const { config } = await import("../config.js");
    expect(config.allowDestructive).toBe(false);
  });
});
