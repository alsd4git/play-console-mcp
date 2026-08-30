import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SignJWT, jwtVerify } from "jose";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  GOOGLE_AUTHORIZATION_URL,
  GOOGLE_OAUTH_TOKEN_URL,
  GOOGLE_PLAY_OAUTH_SCOPES,
} from "../play/oauth.js";
import {
  MCP_OFFLINE_SCOPE,
  MCP_READ_SCOPE,
  MCP_WRITE_SCOPE,
  pkceChallenge,
  uniqueScopes,
  validClientRedirectUri,
  type RemoteOAuthConfig,
} from "./config.js";
import { RemoteOAuthStore } from "./store.js";

const ACCESS_TOKEN_TTL_SECONDS = 3600;
const REFRESH_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;
const TRANSACTION_TTL_MS = 10 * 60 * 1000;
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const BODY_LIMIT_BYTES = 64 * 1024;
const TOKEN_SKEW_MS = 60_000;

interface AuthorizationTransaction {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  clientState?: string;
  expiresAt: number;
}

interface AuthorizationCode extends AuthorizationTransaction {
  subject: string;
  email: string;
}

interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface GoogleUserInfo {
  sub?: string;
  email?: string;
  email_verified?: boolean;
}

interface DcrRequest {
  redirect_uris?: unknown;
  client_name?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
  token_endpoint_auth_method?: unknown;
}

export interface RemoteIdentity {
  subject: string;
  email: string;
  clientId: string;
  scopes: string[];
}

class OAuthProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function signingKey(secret: string): Uint8Array {
  return createHash("sha256").update(`mcp-token\0${secret}`, "utf8").digest();
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function textResponse(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function redirectResponse(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  res.end();
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT_BYTES) {
      throw new OAuthProtocolError("invalid_request", "Request body is too large.", 413);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function subset(requested: string[], granted: string[]): boolean {
  const grantedSet = new Set(granted);
  return requested.every((scope) => grantedSet.has(scope));
}

export class RemoteOAuthBroker {
  readonly resourceMetadataUrl: URL;
  readonly authorizationServerMetadataUrl: URL;
  readonly supportedScopes: readonly string[];
  private readonly store: RemoteOAuthStore;
  private readonly transactions = new Map<string, AuthorizationTransaction>();
  private readonly authorizationCodes = new Map<string, AuthorizationCode>();
  private readonly googleAccessTokens = new Map<string, { token: string; expiresAt: number }>();
  private readonly tokenKey: Uint8Array;

  constructor(readonly config: RemoteOAuthConfig) {
    const resourcePath = config.resource.pathname.replace(/\/$/, "");
    this.resourceMetadataUrl = new URL(
      `/.well-known/oauth-protected-resource${resourcePath || ""}`,
      config.resource.origin,
    );
    this.authorizationServerMetadataUrl = new URL(
      "/.well-known/oauth-authorization-server",
      config.issuer,
    );
    this.supportedScopes = [MCP_READ_SCOPE, MCP_WRITE_SCOPE, MCP_OFFLINE_SCOPE];
    this.store = new RemoteOAuthStore(config.dataPath, config.masterSecret);
    this.tokenKey = signingKey(config.masterSecret);
  }

  private issuer(): string {
    return this.config.issuer.toString().replace(/\/$/, "");
  }

  private tokenEndpoint(): string {
    return new URL("/oauth/token", this.config.issuer).toString();
  }

  private defaultScopes(): string[] {
    return [MCP_READ_SCOPE, MCP_WRITE_SCOPE, MCP_OFFLINE_SCOPE];
  }

  private validateScopes(value: string | undefined, defaults = this.defaultScopes()): string[] {
    const scopes = value === undefined ? defaults : uniqueScopes(value);
    if (scopes.length === 0) {
      throw new OAuthProtocolError("invalid_scope", "At least one scope is required.");
    }
    const supported = new Set(this.supportedScopes);
    for (const scope of scopes) {
      if (!supported.has(scope)) {
        throw new OAuthProtocolError("invalid_scope", `Unsupported scope '${scope}'.`);
      }
    }
    if (!scopes.includes(MCP_READ_SCOPE)) scopes.unshift(MCP_READ_SCOPE);
    return [...new Set(scopes)];
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, value] of this.transactions) {
      if (value.expiresAt <= now) this.transactions.delete(key);
    }
    for (const [key, value] of this.authorizationCodes) {
      if (value.expiresAt <= now) this.authorizationCodes.delete(key);
    }
  }

  private metadata(): Record<string, unknown> {
    return {
      issuer: this.issuer(),
      authorization_endpoint: new URL("/oauth/authorize", this.config.issuer).toString(),
      token_endpoint: this.tokenEndpoint(),
      registration_endpoint: new URL("/oauth/register", this.config.issuer).toString(),
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: this.supportedScopes,
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: false,
    };
  }

  private protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.config.resource.toString(),
      authorization_servers: [this.issuer()],
      bearer_methods_supported: ["header"],
      scopes_supported: this.supportedScopes,
      resource_documentation:
        "https://github.com/alsd4git/play-console-mcp/blob/main/docs/OPENAI.md",
    };
  }

  private async handleRegistration(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let parsed: DcrRequest;
    try {
      parsed = JSON.parse(await readBody(req)) as DcrRequest;
    } catch (error) {
      if (error instanceof OAuthProtocolError) throw error;
      throw new OAuthProtocolError("invalid_client_metadata", "Client metadata must be valid JSON.");
    }
    if (!Array.isArray(parsed.redirect_uris) || parsed.redirect_uris.length === 0) {
      throw new OAuthProtocolError(
        "invalid_client_metadata",
        "redirect_uris must be a non-empty array.",
      );
    }
    const redirectUris = parsed.redirect_uris.filter(
      (value): value is string => typeof value === "string" && validClientRedirectUri(value),
    );
    if (redirectUris.length !== parsed.redirect_uris.length) {
      throw new OAuthProtocolError(
        "invalid_redirect_uri",
        "Every redirect URI must use HTTPS, or HTTP on a loopback address.",
      );
    }
    if (
      parsed.token_endpoint_auth_method !== undefined &&
      parsed.token_endpoint_auth_method !== "none"
    ) {
      throw new OAuthProtocolError(
        "invalid_client_metadata",
        "This server supports public OAuth clients with token_endpoint_auth_method=none.",
      );
    }
    if (
      Array.isArray(parsed.grant_types) &&
      parsed.grant_types.some(
        (grant) => grant !== "authorization_code" && grant !== "refresh_token",
      )
    ) {
      throw new OAuthProtocolError("invalid_client_metadata", "Unsupported OAuth grant type.");
    }
    if (
      Array.isArray(parsed.response_types) &&
      parsed.response_types.some((responseType) => responseType !== "code")
    ) {
      throw new OAuthProtocolError(
        "invalid_client_metadata",
        "Only response_type=code is supported.",
      );
    }

    const client = await this.store.registerClient({
      redirectUris,
      ...(typeof parsed.client_name === "string" ? { clientName: parsed.client_name } : {}),
    });
    jsonResponse(res, 201, {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
      redirect_uris: client.redirectUris,
      client_name: client.clientName,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  }

  private async handleAuthorization(url: URL, res: ServerResponse): Promise<void> {
    this.cleanup();
    if (url.searchParams.get("response_type") !== "code") {
      throw new OAuthProtocolError(
        "unsupported_response_type",
        "Only response_type=code is supported.",
      );
    }
    const clientId = url.searchParams.get("client_id") ?? "";
    const client = await this.store.client(clientId);
    if (!client) throw new OAuthProtocolError("unauthorized_client", "Unknown OAuth client_id.");
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    if (!client.redirectUris.includes(redirectUri)) {
      throw new OAuthProtocolError(
        "invalid_request",
        "redirect_uri is not registered for this client.",
      );
    }
    const codeChallenge = url.searchParams.get("code_challenge") ?? "";
    if (!codeChallenge || url.searchParams.get("code_challenge_method") !== "S256") {
      throw new OAuthProtocolError(
        "invalid_request",
        "PKCE with code_challenge_method=S256 is required.",
      );
    }
    const resource = url.searchParams.get("resource");
    if (
      resource &&
      resource.replace(/\/$/, "") !== this.config.resource.toString().replace(/\/$/, "")
    ) {
      throw new OAuthProtocolError("invalid_target", "OAuth resource does not match this MCP server.");
    }
    const scopes = this.validateScopes(url.searchParams.get("scope") ?? undefined);
    if (this.transactions.size >= 1000) {
      throw new OAuthProtocolError(
        "temporarily_unavailable",
        "Too many pending authorization requests. Try again later.",
        503,
      );
    }
    const state = randomBytes(32).toString("base64url");
    this.transactions.set(state, {
      clientId,
      redirectUri,
      codeChallenge,
      scopes,
      ...(url.searchParams.get("state") ? { clientState: url.searchParams.get("state")! } : {}),
      expiresAt: Date.now() + TRANSACTION_TTL_MS,
    });

    const googleUrl = new URL(GOOGLE_AUTHORIZATION_URL);
    googleUrl.search = new URLSearchParams({
      client_id: this.config.googleClient.clientId,
      redirect_uri: this.config.googleRedirectUri.toString(),
      response_type: "code",
      scope: ["openid", "email", ...GOOGLE_PLAY_OAUTH_SCOPES].join(" "),
      access_type: "offline",
      prompt: "consent select_account",
      include_granted_scopes: "true",
      state,
    }).toString();
    redirectResponse(res, googleUrl.toString());
  }

  private async googleTokenRequest(params: URLSearchParams): Promise<GoogleTokenResponse> {
    const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let parsed: GoogleTokenResponse;
    try {
      parsed = text ? (JSON.parse(text) as GoogleTokenResponse) : {};
    } catch {
      throw new Error(`Google OAuth token endpoint returned an invalid response (${response.status}).`);
    }
    if (!response.ok || parsed.error) {
      throw new Error(
        `Google OAuth token request failed: ${parsed.error_description ?? parsed.error ?? response.statusText}`,
      );
    }
    return parsed;
  }

  private async handleGoogleCallback(url: URL, res: ServerResponse): Promise<void> {
    this.cleanup();
    const state = url.searchParams.get("state") ?? "";
    const transaction = this.transactions.get(state);
    if (!transaction) {
      throw new OAuthProtocolError(
        "invalid_request",
        "Google OAuth transaction is missing or expired.",
      );
    }
    this.transactions.delete(state);

    const clientRedirect = (error?: string): URL => {
      const redirect = new URL(transaction.redirectUri);
      if (error) redirect.searchParams.set("error", error);
      if (transaction.clientState) redirect.searchParams.set("state", transaction.clientState);
      redirect.searchParams.set("iss", this.issuer());
      return redirect;
    };

    if (url.searchParams.get("error")) {
      redirectResponse(
        res,
        clientRedirect(url.searchParams.get("error") ?? "access_denied").toString(),
      );
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      redirectResponse(res, clientRedirect("access_denied").toString());
      return;
    }

    const token = await this.googleTokenRequest(
      new URLSearchParams({
        code,
        client_id: this.config.googleClient.clientId,
        client_secret: this.config.googleClient.clientSecret ?? "",
        redirect_uri: this.config.googleRedirectUri.toString(),
        grant_type: "authorization_code",
      }),
    );
    if (!token.access_token) throw new Error("Google OAuth response did not contain access_token.");

    const userResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!userResponse.ok) {
      throw new Error(
        `Google userinfo request failed: ${userResponse.status} ${userResponse.statusText}`,
      );
    }
    const user = (await userResponse.json()) as GoogleUserInfo;
    if (!user.sub || !user.email) throw new Error("Google account did not return a subject and email.");
    if (user.email_verified !== true) throw new Error("Google account email is not verified.");
    const email = user.email.toLowerCase();
    if (!this.config.allowAnyGoogleAccount && !this.config.allowedEmails.has(email)) {
      redirectResponse(res, clientRedirect("access_denied").toString());
      return;
    }

    await this.store.upsertGoogleUser({
      subject: user.sub,
      email,
      refreshToken: token.refresh_token,
      googleScopes: uniqueScopes(token.scope),
    });
    this.googleAccessTokens.set(user.sub, {
      token: token.access_token,
      expiresAt: Date.now() + (token.expires_in ?? ACCESS_TOKEN_TTL_SECONDS) * 1000,
    });

    const authorizationCode = `mcp_ac_${randomBytes(32).toString("base64url")}`;
    this.authorizationCodes.set(authorizationCode, {
      ...transaction,
      subject: user.sub,
      email,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });
    const redirect = clientRedirect();
    redirect.searchParams.set("code", authorizationCode);
    redirectResponse(res, redirect.toString());
  }

  private async issueToken(
    input: { clientId: string; subject: string; email: string; scopes: string[] },
    use: "access" | "refresh",
  ): Promise<string> {
    const audience = use === "access" ? this.config.resource.toString() : this.tokenEndpoint();
    const ttl = use === "access" ? ACCESS_TOKEN_TTL_SECONDS : REFRESH_TOKEN_TTL_SECONDS;
    return new SignJWT({
      client_id: input.clientId,
      email: input.email,
      scope: input.scopes.join(" "),
      token_use: use,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(this.issuer())
      .setAudience(audience)
      .setSubject(input.subject)
      .setIssuedAt()
      .setJti(randomBytes(16).toString("base64url"))
      .setExpirationTime(`${ttl}s`)
      .sign(this.tokenKey);
  }

  private tokenResponse(input: {
    accessToken: string;
    refreshToken?: string;
    scopes: string[];
  }): Record<string, unknown> {
    return {
      access_token: input.accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      scope: input.scopes.join(" "),
      ...(input.refreshToken ? { refresh_token: input.refreshToken } : {}),
    };
  }

  private async handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.cleanup();
    const params = new URLSearchParams(await readBody(req));
    const grantType = params.get("grant_type");
    const clientId = params.get("client_id") ?? "";
    if (!clientId || !(await this.store.client(clientId))) {
      throw new OAuthProtocolError("invalid_client", "Unknown OAuth client_id.", 401);
    }

    if (grantType === "authorization_code") {
      const code = params.get("code") ?? "";
      const record = this.authorizationCodes.get(code);
      this.authorizationCodes.delete(code);
      if (
        !record ||
        record.expiresAt <= Date.now() ||
        record.clientId !== clientId ||
        record.redirectUri !== (params.get("redirect_uri") ?? "")
      ) {
        throw new OAuthProtocolError("invalid_grant", "Authorization code is invalid or expired.");
      }
      const verifier = params.get("code_verifier") ?? "";
      if (!verifier || pkceChallenge(verifier) !== record.codeChallenge) {
        throw new OAuthProtocolError("invalid_grant", "PKCE verification failed.");
      }
      const identity = {
        clientId: record.clientId,
        subject: record.subject,
        email: record.email,
        scopes: record.scopes,
      };
      const accessToken = await this.issueToken(identity, "access");
      const refreshToken = record.scopes.includes(MCP_OFFLINE_SCOPE)
        ? await this.issueToken(identity, "refresh")
        : undefined;
      jsonResponse(res, 200, this.tokenResponse({ accessToken, refreshToken, scopes: record.scopes }));
      return;
    }

    if (grantType === "refresh_token") {
      const presented = params.get("refresh_token") ?? "";
      if (!presented) throw new OAuthProtocolError("invalid_grant", "refresh_token is required.");
      let payload;
      try {
        ({ payload } = await jwtVerify(presented, this.tokenKey, {
          issuer: this.issuer(),
          audience: this.tokenEndpoint(),
          algorithms: ["HS256"],
        }));
      } catch {
        throw new OAuthProtocolError("invalid_grant", "Refresh token is invalid or expired.");
      }
      if (payload.token_use !== "refresh" || payload.client_id !== clientId || !payload.sub) {
        throw new OAuthProtocolError("invalid_grant", "Refresh token is invalid for this client.");
      }
      const email = typeof payload.email === "string" ? payload.email : undefined;
      const granted = typeof payload.scope === "string" ? uniqueScopes(payload.scope) : [];
      if (!email || !granted.includes(MCP_READ_SCOPE)) {
        throw new OAuthProtocolError("invalid_grant", "Refresh token has incomplete claims.");
      }
      const requested = params.has("scope")
        ? this.validateScopes(params.get("scope") ?? "")
        : granted;
      if (!subset(requested, granted)) {
        throw new OAuthProtocolError(
          "invalid_scope",
          "Refresh cannot widen the originally granted scopes.",
        );
      }
      const identity = { clientId, subject: payload.sub, email, scopes: requested };
      const accessToken = await this.issueToken(identity, "access");
      const refreshToken = await this.issueToken(identity, "refresh");
      jsonResponse(res, 200, this.tokenResponse({ accessToken, refreshToken, scopes: requested }));
      return;
    }

    throw new OAuthProtocolError("unsupported_grant_type", "Unsupported OAuth grant_type.");
  }

  private oauthError(res: ServerResponse, error: unknown): void {
    const protocol =
      error instanceof OAuthProtocolError
        ? error
        : new OAuthProtocolError(
            "server_error",
            error instanceof Error ? error.message : String(error),
            500,
          );
    jsonResponse(res, protocol.status, {
      error: protocol.code,
      error_description: protocol.message,
    });
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const requestUrl = new URL(req.url ?? "/", this.config.resource.origin);
    const path = requestUrl.pathname;
    const protectedResourcePaths = new Set([
      this.resourceMetadataUrl.pathname,
      "/.well-known/oauth-protected-resource",
    ]);

    try {
      if (req.method === "GET" && protectedResourcePaths.has(path)) {
        jsonResponse(res, 200, this.protectedResourceMetadata());
        return true;
      }
      if (req.method === "GET" && path === this.authorizationServerMetadataUrl.pathname) {
        jsonResponse(res, 200, this.metadata());
        return true;
      }
      if (req.method === "GET" && path === "/oauth/authorize") {
        await this.handleAuthorization(requestUrl, res);
        return true;
      }
      if (req.method === "GET" && path === this.config.googleRedirectUri.pathname) {
        await this.handleGoogleCallback(requestUrl, res);
        return true;
      }
      if (req.method === "POST" && path === "/oauth/register") {
        await this.handleRegistration(req, res);
        return true;
      }
      if (req.method === "POST" && path === "/oauth/token") {
        await this.handleToken(req, res);
        return true;
      }
      if (req.method === "GET" && path === "/healthz") {
        jsonResponse(res, 200, { ok: true });
        return true;
      }
      return false;
    } catch (error) {
      if (path === "/oauth/authorize" || path === this.config.googleRedirectUri.pathname) {
        textResponse(
          res,
          error instanceof OAuthProtocolError ? error.status : 500,
          error instanceof Error ? error.message : String(error),
        );
      } else {
        this.oauthError(res, error);
      }
      return true;
    }
  }

  async verifyMcpAccessToken(token: string): Promise<AuthInfo> {
    const { payload } = await jwtVerify(token, this.tokenKey, {
      issuer: this.issuer(),
      audience: this.config.resource.toString(),
      algorithms: ["HS256"],
    });
    const clientId = typeof payload.client_id === "string" ? payload.client_id : undefined;
    const email = typeof payload.email === "string" ? payload.email : undefined;
    const subject = payload.sub;
    const scopes = typeof payload.scope === "string" ? uniqueScopes(payload.scope) : [];
    if (
      payload.token_use !== "access" ||
      !clientId ||
      !email ||
      !subject ||
      !scopes.includes(MCP_READ_SCOPE)
    ) {
      throw new Error("MCP access token is missing required identity or scope claims.");
    }
    return {
      token,
      clientId,
      scopes,
      expiresAt: typeof payload.exp === "number" ? payload.exp : undefined,
      extra: { subject, email },
    };
  }

  identityFromAuth(auth: AuthInfo): RemoteIdentity {
    const subject = auth.extra?.subject;
    const email = auth.extra?.email;
    if (typeof subject !== "string" || typeof email !== "string") {
      throw new Error("Authenticated MCP request has no Google identity.");
    }
    return { subject, email, clientId: auth.clientId, scopes: auth.scopes };
  }

  createGoogleTokenProvider(subject: string): () => Promise<string> {
    return async () => {
      const cached = this.googleAccessTokens.get(subject);
      if (cached && cached.expiresAt - TOKEN_SKEW_MS > Date.now()) return cached.token;

      const refreshToken = await this.store.googleRefreshToken(subject);
      const response = await this.googleTokenRequest(
        new URLSearchParams({
          client_id: this.config.googleClient.clientId,
          client_secret: this.config.googleClient.clientSecret ?? "",
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
      );
      if (!response.access_token) {
        throw new Error("Google OAuth refresh returned no access_token. Reconnect this app.");
      }
      if (response.refresh_token) {
        await this.store.updateGoogleRefreshToken(subject, response.refresh_token);
      }
      this.googleAccessTokens.set(subject, {
        token: response.access_token,
        expiresAt: Date.now() + (response.expires_in ?? ACCESS_TOKEN_TTL_SECONDS) * 1000,
      });
      return response.access_token;
    };
  }
}

export function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || undefined;
}
