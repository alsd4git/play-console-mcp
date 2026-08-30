import { createHash, randomBytes } from "node:crypto";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { loadOAuthClientConfig, type OAuthClientConfig } from "../play/oauth.js";

export const MCP_READ_SCOPE = "play.read";
export const MCP_WRITE_SCOPE = "play.write";
export const MCP_DESTRUCTIVE_SCOPE = "play.destructive";
export const MCP_OFFLINE_SCOPE = "offline_access";

export interface RemoteOAuthConfig {
  resource: URL;
  issuer: URL;
  googleClient: OAuthClientConfig;
  googleRedirectUri: URL;
  masterSecret: string;
  dataPath: string;
  allowedEmails: ReadonlySet<string>;
  allowAnyGoogleAccount: boolean;
  allowDestructive: boolean;
}

function envBoolean(name: string): boolean {
  return /^(1|true|yes)$/i.test(process.env[name]?.trim() ?? "");
}

function envValue(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

export function isLoopbackHostname(hostname: string): boolean {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname.toLowerCase());
}

function assertNetworkUrl(url: URL, name: string, allowInsecureHttp: boolean): void {
  if (url.username || url.password || url.hash) {
    throw new Error(`${name} must not contain credentials or a fragment.`);
  }
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && (allowInsecureHttp || isLoopbackHostname(url.hostname))) return;
  throw new Error(`${name} must use https (http is only accepted for loopback development).`);
}

function remoteDataPath(): string {
  const override = envValue("MCP_OAUTH_DATA_PATH");
  if (override) return override;
  if (platform() === "win32") {
    const appData = envValue("APPDATA") ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "play-console-mcp", "remote-oauth.json");
  }
  if (platform() === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "play-console-mcp",
      "remote-oauth.json",
    );
  }
  const configHome = envValue("XDG_CONFIG_HOME") ?? join(homedir(), ".config");
  return join(configHome, "play-console-mcp", "remote-oauth.json");
}

function parseAllowedEmails(): ReadonlySet<string> {
  const raw = envValue("GOOGLE_OAUTH_ALLOWED_EMAILS");
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

export async function loadRemoteOAuthConfig(): Promise<RemoteOAuthConfig> {
  const publicUrl = envValue("MCP_PUBLIC_URL");
  if (!publicUrl) {
    throw new Error(
      "MCP_PUBLIC_URL is required for remote OAuth mode, e.g. https://play-mcp.example.com/mcp.",
    );
  }
  const resource = new URL(publicUrl);
  const allowInsecureHttp = envBoolean("MCP_ALLOW_INSECURE_HTTP");
  assertNetworkUrl(resource, "MCP_PUBLIC_URL", allowInsecureHttp);

  const issuer = new URL(envValue("MCP_OAUTH_ISSUER") ?? resource.origin);
  if (issuer.username || issuer.password || issuer.search || issuer.hash) {
    throw new Error("MCP_OAUTH_ISSUER must not contain credentials, a query string, or a fragment.");
  }
  issuer.pathname = issuer.pathname.replace(/\/$/, "") || "/";
  assertNetworkUrl(issuer, "MCP_OAUTH_ISSUER", allowInsecureHttp);

  const masterSecret = envValue("MCP_OAUTH_SECRET");
  if (!masterSecret || masterSecret.length < 32) {
    throw new Error(
      "MCP_OAUTH_SECRET must be a high-entropy secret of at least 32 characters. Generate one with 'play-console-mcp remote secret'.",
    );
  }

  const googleClient = await loadOAuthClientConfig();
  if (googleClient.clientType === "installed" || !googleClient.clientSecret) {
    throw new Error(
      "Remote OAuth mode requires a Google Web OAuth client with a client secret. Set GOOGLE_OAUTH_CLIENT_CONFIG_PATH to a Web client JSON, or set GOOGLE_OAUTH_CLIENT_ID/GOOGLE_OAUTH_CLIENT_SECRET.",
    );
  }

  const googleRedirectUri = new URL(
    envValue("GOOGLE_OAUTH_REDIRECT_URI") ?? new URL("/oauth/google/callback", issuer).toString(),
  );
  assertNetworkUrl(googleRedirectUri, "GOOGLE_OAUTH_REDIRECT_URI", allowInsecureHttp);
  if (
    googleClient.redirectUris.length > 0 &&
    !googleClient.redirectUris.includes(googleRedirectUri.toString())
  ) {
    throw new Error(
      `Google OAuth client does not list ${googleRedirectUri.toString()} as a redirect URI. Add it in Google Cloud or set GOOGLE_OAUTH_REDIRECT_URI to a registered URI.`,
    );
  }

  const allowedEmails = parseAllowedEmails();
  const allowAnyGoogleAccount = envBoolean("MCP_OAUTH_ALLOW_ANY_GOOGLE_ACCOUNT");
  if (allowedEmails.size === 0 && !allowAnyGoogleAccount) {
    throw new Error(
      "Remote OAuth is closed by default. Set GOOGLE_OAUTH_ALLOWED_EMAILS to the Google account(s) allowed to connect, or explicitly set MCP_OAUTH_ALLOW_ANY_GOOGLE_ACCOUNT=1.",
    );
  }

  return {
    resource,
    issuer,
    googleClient,
    googleRedirectUri,
    masterSecret,
    dataPath: remoteDataPath(),
    allowedEmails,
    allowAnyGoogleAccount,
    allowDestructive: envBoolean("GOOGLE_PLAY_ALLOW_DESTRUCTIVE"),
  };
}

export function validClientRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

export function uniqueScopes(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(/\s+/).map((item) => item.trim()).filter(Boolean))];
}

export function remoteSecret(): string {
  return randomBytes(48).toString("base64url");
}
