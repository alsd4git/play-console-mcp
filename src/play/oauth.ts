import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

export const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_PLAY_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/androidpublisher",
  "https://www.googleapis.com/auth/playdeveloperreporting",
] as const;

const TOKEN_SKEW_MS = 60_000;
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;

interface GoogleOAuthClientSection {
  client_id?: string;
  client_secret?: string;
  redirect_uris?: string[];
}

interface GoogleOAuthClientFile {
  installed?: GoogleOAuthClientSection;
  web?: GoogleOAuthClientSection;
}

interface OAuthTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

export interface OAuthClientConfig {
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
  clientType: "installed" | "web" | "environment";
}

export interface OAuthTokenRecord {
  version: 1;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
  scopes: string[];
  tokenType?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OAuthLoginOptions {
  client: OAuthClientConfig;
  tokenPath?: string;
  port?: number;
  redirectUri?: string;
  openBrowser?: boolean;
  timeoutMs?: number;
  onAuthorizationUrl?: (url: string) => void;
}

export interface OAuthTokenProviderOptions {
  tokenPath?: string;
}

function envPath(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function defaultOAuthTokenPath(): string {
  const override = envPath("GOOGLE_OAUTH_TOKEN_PATH");
  if (override) return override;

  if (platform() === "win32") {
    const appData = envPath("APPDATA") ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "play-console-mcp", "google-oauth.json");
  }
  if (platform() === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "play-console-mcp",
      "google-oauth.json",
    );
  }
  const configHome = envPath("XDG_CONFIG_HOME") ?? join(homedir(), ".config");
  return join(configHome, "play-console-mcp", "google-oauth.json");
}

export function parseOAuthClientConfig(
  text: string,
  source = "OAuth client configuration",
): OAuthClientConfig {
  let parsed: GoogleOAuthClientFile;
  try {
    parsed = JSON.parse(text) as GoogleOAuthClientFile;
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${String(error)}`, { cause: error });
  }

  const section = parsed.installed ?? parsed.web;
  const clientType = parsed.installed ? "installed" : parsed.web ? "web" : undefined;
  if (!section?.client_id || !clientType) {
    throw new Error(
      `${source} must contain an 'installed' or 'web' OAuth client with client_id.`,
    );
  }
  return {
    clientId: section.client_id,
    ...(section.client_secret ? { clientSecret: section.client_secret } : {}),
    redirectUris: section.redirect_uris ?? [],
    clientType,
  };
}

export async function loadOAuthClientConfig(
  options: {
    path?: string;
    clientId?: string;
    clientSecret?: string;
  } = {},
): Promise<OAuthClientConfig> {
  const path = options.path ?? envPath("GOOGLE_OAUTH_CLIENT_CONFIG_PATH");
  if (path) {
    return parseOAuthClientConfig(await readFile(path, "utf8"), path);
  }

  const clientId = options.clientId ?? envPath("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = options.clientSecret ?? envPath("GOOGLE_OAUTH_CLIENT_SECRET");
  if (!clientId) {
    throw new Error(
      "No Google OAuth client configured. Pass --client /path/to/client_secret.json or set GOOGLE_OAUTH_CLIENT_CONFIG_PATH (or GOOGLE_OAUTH_CLIENT_ID).",
    );
  }
  return {
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    redirectUris: [],
    clientType: "environment",
  };
}

function validateTokenRecord(value: unknown, source: string): OAuthTokenRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} is not a valid OAuth token record.`);
  }
  const record = value as Partial<OAuthTokenRecord>;
  if (
    record.version !== 1 ||
    typeof record.clientId !== "string" ||
    typeof record.refreshToken !== "string" ||
    !Array.isArray(record.scopes)
  ) {
    throw new Error(`${source} is missing clientId, refreshToken, scopes, or version.`);
  }
  return record as OAuthTokenRecord;
}

export async function readOAuthTokenRecord(
  tokenPath = defaultOAuthTokenPath(),
): Promise<OAuthTokenRecord> {
  let text: string;
  try {
    text = await readFile(tokenPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `No Google OAuth login found at ${tokenPath}. Run 'play-console-mcp auth login --client /path/to/client_secret.json'.`,
        { cause: error },
      );
    }
    throw error;
  }
  try {
    return validateTokenRecord(JSON.parse(text), tokenPath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${tokenPath} is not valid JSON: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

export async function writeOAuthTokenRecord(
  record: OAuthTokenRecord,
  tokenPath = defaultOAuthTokenPath(),
): Promise<void> {
  const directory = dirname(tokenPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);

  const temporaryPath = `${tokenPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });

  try {
    await rename(temporaryPath, tokenPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (platform() === "win32" && (code === "EEXIST" || code === "EPERM")) {
      await rm(tokenPath, { force: true });
      await rename(temporaryPath, tokenPath);
    } else {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
  await chmod(tokenPath, 0o600).catch(() => undefined);
}

export async function deleteOAuthTokenRecord(
  tokenPath = defaultOAuthTokenPath(),
): Promise<boolean> {
  try {
    await rm(tokenPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function tokenRequest(params: URLSearchParams): Promise<OAuthTokenResponse> {
  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const text = await response.text();
  let result: OAuthTokenResponse;
  try {
    result = text ? (JSON.parse(text) as OAuthTokenResponse) : {};
  } catch {
    throw new Error(
      `Google OAuth token endpoint returned ${response.status} ${response.statusText}: ${text}`,
    );
  }
  if (!response.ok || result.error) {
    const detail = result.error_description ?? result.error ?? text;
    const errorCode = result.error ? `${result.error}: ` : "";
    throw new Error(
      `Google OAuth token request failed: ${response.status} ${response.statusText}: ${errorCode}${detail}`,
    );
  }
  return result;
}

function updatedRecord(
  current: OAuthTokenRecord,
  response: OAuthTokenResponse,
  now: number,
): OAuthTokenRecord {
  if (!response.access_token) throw new Error("Google OAuth response did not contain access_token.");
  return {
    ...current,
    refreshToken: response.refresh_token ?? current.refreshToken,
    accessToken: response.access_token,
    expiresAt: now + (response.expires_in ?? 3600) * 1000,
    scopes: response.scope ? response.scope.split(/\s+/).filter(Boolean) : current.scopes,
    tokenType: response.token_type ?? current.tokenType,
    updatedAt: new Date(now).toISOString(),
  };
}

export function createOAuthTokenProvider(
  options: OAuthTokenProviderOptions = {},
  now: () => number = Date.now,
): () => Promise<string> {
  const tokenPath = options.tokenPath ?? defaultOAuthTokenPath();
  let cached: OAuthTokenRecord | undefined;
  let refreshInFlight: Promise<string> | undefined;

  return async () => {
    cached ??= await readOAuthTokenRecord(tokenPath);
    const currentTime = now();
    if (
      cached.accessToken &&
      cached.expiresAt !== undefined &&
      cached.expiresAt - TOKEN_SKEW_MS > currentTime
    ) {
      return cached.accessToken;
    }

    refreshInFlight ??= (async () => {
      const params = new URLSearchParams({
        client_id: cached?.clientId ?? "",
        refresh_token: cached?.refreshToken ?? "",
        grant_type: "refresh_token",
      });
      if (cached?.clientSecret) params.set("client_secret", cached.clientSecret);
      const response = await tokenRequest(params);
      cached = updatedRecord(cached as OAuthTokenRecord, response, now());
      await writeOAuthTokenRecord(cached, tokenPath);
      return cached.accessToken as string;
    })().finally(() => {
      refreshInFlight = undefined;
    });

    return refreshInFlight;
  };
}

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function assertLoopbackRedirect(uri: URL): void {
  const host = uri.hostname.replace(/^\[|\]$/g, "");
  if (uri.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("OAuth redirect URI must be an http:// loopback address for local login.");
  }
}

async function listen(server: Server, host: string, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not determine OAuth callback port.");
  }
  return address.port;
}

export function openExternalUrl(url: string): boolean {
  const currentPlatform = platform();
  const command =
    currentPlatform === "darwin"
      ? { executable: "open", args: [url] }
      : currentPlatform === "win32"
        ? { executable: "rundll32", args: ["url.dll,FileProtocolHandler", url] }
        : { executable: "xdg-open", args: [url] };
  try {
    const child = spawn(command.executable, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function loginWithGoogleOAuth(
  options: OAuthLoginOptions,
): Promise<OAuthTokenRecord> {
  const state = base64Url(randomBytes(24));
  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const configuredRedirect = options.redirectUri ? new URL(options.redirectUri) : undefined;
  if (configuredRedirect) assertLoopbackRedirect(configuredRedirect);
  const callbackPath = configuredRedirect?.pathname || "/oauth2/callback";
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  let settled = false;
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== callbackPath) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    const returnedState = requestUrl.searchParams.get("state");
    const oauthError = requestUrl.searchParams.get("error");
    const code = requestUrl.searchParams.get("code");
    if (settled) {
      response.writeHead(409, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("This OAuth request has already completed.");
      return;
    }
    settled = true;

    if (returnedState !== state) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("OAuth state did not match. You can close this tab.");
      rejectCode(new Error("Google OAuth callback state did not match."));
      return;
    }
    if (oauthError) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Google authorization was not completed. You can close this tab.");
      rejectCode(new Error(`Google OAuth authorization failed: ${oauthError}`));
      return;
    }
    if (!code) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("No authorization code was returned. You can close this tab.");
      rejectCode(new Error("Google OAuth callback did not contain an authorization code."));
      return;
    }

    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(
      "<!doctype html><title>Google Play Console connected</title><h1>Connected</h1><p>You can close this tab and return to the terminal.</p>",
    );
    resolveCode(code);
  });

  let redirectUri: URL;
  if (configuredRedirect) {
    redirectUri = configuredRedirect;
    const port = Number(redirectUri.port || "80");
    await listen(server, redirectUri.hostname, port);
  } else {
    const port = await listen(server, "127.0.0.1", options.port ?? 0);
    redirectUri = new URL(`http://127.0.0.1:${port}${callbackPath}`);
  }

  const authorizationUrl = new URL(GOOGLE_AUTHORIZATION_URL);
  authorizationUrl.search = new URLSearchParams({
    client_id: options.client.clientId,
    redirect_uri: redirectUri.toString(),
    response_type: "code",
    scope: GOOGLE_PLAY_OAUTH_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  const authorizationUrlString = authorizationUrl.toString();
  options.onAuthorizationUrl?.(authorizationUrlString);
  if (options.openBrowser !== false) openExternalUrl(authorizationUrlString);

  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectCode(new Error("Google OAuth login timed out before the browser callback arrived."));
    }
  }, options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS);
  timeout.unref();

  try {
    const code = await codePromise;
    const params = new URLSearchParams({
      client_id: options.client.clientId,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri.toString(),
    });
    if (options.client.clientSecret) params.set("client_secret", options.client.clientSecret);
    const token = await tokenRequest(params);
    if (!token.refresh_token) {
      throw new Error(
        "Google did not return a refresh token. Revoke the app grant and retry, or keep prompt=consent enabled.",
      );
    }

    const now = Date.now();
    const record: OAuthTokenRecord = {
      version: 1,
      clientId: options.client.clientId,
      ...(options.client.clientSecret ? { clientSecret: options.client.clientSecret } : {}),
      refreshToken: token.refresh_token,
      ...(token.access_token ? { accessToken: token.access_token } : {}),
      ...(token.expires_in ? { expiresAt: now + token.expires_in * 1000 } : {}),
      scopes: token.scope
        ? token.scope.split(/\s+/).filter(Boolean)
        : [...GOOGLE_PLAY_OAUTH_SCOPES],
      ...(token.token_type ? { tokenType: token.token_type } : {}),
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
    await writeOAuthTokenRecord(record, options.tokenPath ?? defaultOAuthTokenPath());
    return record;
  } finally {
    clearTimeout(timeout);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
