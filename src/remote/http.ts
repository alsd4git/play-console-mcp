import { randomUUID } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { GooglePlayClient, REPORTING_BASE_URL } from "../play/client.js";
import { createServer } from "../server.js";
import { bearerToken, RemoteOAuthBroker } from "./oauth.js";
import {
  isLoopbackHostname,
  loadRemoteOAuthConfig,
  MCP_READ_SCOPE,
  MCP_WRITE_SCOPE,
} from "./config.js";

interface AuthenticatedRequest extends IncomingMessage {
  auth?: AuthInfo;
}

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof createServer>;
  subject: string;
  clientId: string;
  scopes: ReadonlySet<string>;
}

function envBoolean(name: string): boolean {
  return /^(1|true|yes)$/i.test(process.env[name]?.trim() ?? "");
}

function packageAllowlist(): ReadonlySet<string> | undefined {
  const raw = process.env.GOOGLE_PLAY_ALLOWED_PACKAGES;
  if (!raw) return undefined;
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? new Set(values) : undefined;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return result;
}

function numericPort(value: string | undefined): number {
  const port = positiveInteger(value, 8787, "MCP_HTTP_PORT");
  if (port > 65535) throw new Error("MCP_HTTP_PORT must not exceed 65535.");
  return port;
}

function sessionId(req: IncomingMessage): string | undefined {
  const value = req.headers["mcp-session-id"];
  return Array.isArray(value) ? value[0] : value;
}

function jsonError(res: ServerResponse, status: number, message: string): void {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  });
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function authChallenge(broker: RemoteOAuthBroker, error?: string, scope?: string): string {
  const parts = [`resource_metadata="${broker.resourceMetadataUrl.toString()}"`];
  if (error) parts.push(`error="${error}"`);
  if (scope) parts.push(`scope="${scope}"`);
  return `Bearer ${parts.join(", ")}`;
}

async function authenticate(
  req: AuthenticatedRequest,
  res: ServerResponse,
  broker: RemoteOAuthBroker,
): Promise<AuthInfo | undefined> {
  const token = bearerToken(req);
  if (!token) {
    res.writeHead(401, {
      "WWW-Authenticate": authChallenge(broker),
      "Cache-Control": "no-store",
    });
    res.end();
    return undefined;
  }

  let auth: AuthInfo;
  try {
    auth = await broker.verifyMcpAccessToken(token);
  } catch {
    res.writeHead(401, {
      "WWW-Authenticate": authChallenge(broker, "invalid_token"),
      "Cache-Control": "no-store",
    });
    res.end();
    return undefined;
  }

  if (!auth.scopes.includes(MCP_READ_SCOPE)) {
    res.writeHead(403, {
      "WWW-Authenticate": authChallenge(broker, "insufficient_scope", MCP_READ_SCOPE),
      "Cache-Control": "no-store",
    });
    res.end();
    return undefined;
  }

  req.auth = auth;
  return auth;
}

function hasAllScopes(current: string[], required: ReadonlySet<string>): boolean {
  const currentSet = new Set(current);
  return [...required].every((scope) => currentSet.has(scope));
}

export async function startRemoteServer(): Promise<void> {
  const broker = new RemoteOAuthBroker(await loadRemoteOAuthConfig());
  const sessions = new Map<string, McpSession>();
  const host = process.env.MCP_HTTP_HOST?.trim() || "127.0.0.1";
  const port = numericPort(process.env.MCP_HTTP_PORT?.trim() || undefined);
  const maxSessions = positiveInteger(
    process.env.MCP_HTTP_MAX_SESSIONS?.trim() || undefined,
    100,
    "MCP_HTTP_MAX_SESSIONS",
  );
  if (!isLoopbackHostname(host) && !envBoolean("MCP_HTTP_ALLOW_PUBLIC_BIND")) {
    throw new Error(
      "Remote HTTP binds to loopback by default. Set MCP_HTTP_ALLOW_PUBLIC_BIND=1 explicitly before binding a non-loopback address.",
    );
  }
  const defaultPackageName = process.env.GOOGLE_PLAY_PACKAGE_NAME?.trim() || undefined;
  const allowedPackages = packageAllowlist();
  const destructiveConfigured = broker.config.allowDestructive;
  const mcpPath = broker.config.resource.pathname.replace(/\/$/, "") || "/";

  const httpServer = createHttpServer(async (rawReq, res) => {
    const req = rawReq as AuthenticatedRequest;
    try {
      if (await broker.handle(req, res)) return;

      const requestUrl = new URL(req.url ?? "/", broker.config.resource.origin);
      if ((requestUrl.pathname.replace(/\/$/, "") || "/") !== mcpPath) {
        jsonError(res, 404, "Not found");
        return;
      }

      const auth = await authenticate(req, res, broker);
      if (!auth) return;
      const identity = broker.identityFromAuth(auth);
      const sid = sessionId(req);

      if (sid) {
        const session = sessions.get(sid);
        if (!session) {
          jsonError(res, 404, "MCP session not found");
          return;
        }
        if (session.subject !== identity.subject || session.clientId !== identity.clientId) {
          res.writeHead(403, {
            "WWW-Authenticate": authChallenge(broker, "invalid_token"),
            "Cache-Control": "no-store",
          });
          res.end();
          return;
        }
        if (!hasAllScopes(auth.scopes, session.scopes)) {
          res.writeHead(403, {
            "WWW-Authenticate": authChallenge(
              broker,
              "insufficient_scope",
              [...session.scopes].join(" "),
            ),
            "Cache-Control": "no-store",
          });
          res.end();
          return;
        }
        await session.transport.handleRequest(req, res);
        return;
      }

      if (req.method !== "POST") {
        jsonError(res, 400, "MCP session ID is required after initialization");
        return;
      }
      if (sessions.size >= maxSessions) {
        jsonError(res, 503, "MCP session limit reached");
        return;
      }

      const googleTokenProvider = broker.createGoogleTokenProvider(identity.subject);
      const publisherClient = new GooglePlayClient(googleTokenProvider);
      const reportingClient = new GooglePlayClient(googleTokenProvider, REPORTING_BASE_URL);
      const profile = auth.scopes.includes(MCP_WRITE_SCOPE) ? "full" : "readonly";
      const mcpServer = createServer(
        publisherClient,
        reportingClient,
        defaultPackageName,
        destructiveConfigured,
        { profile, allowedPackages },
      );
      const requiredScopes = new Set(
        auth.scopes.filter((scope) => [MCP_READ_SCOPE, MCP_WRITE_SCOPE].includes(scope)),
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, {
            transport,
            server: mcpServer,
            subject: identity.subject,
            clientId: identity.clientId,
            scopes: requiredScopes,
          });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
      if (!transport.sessionId) await mcpServer.close().catch(() => undefined);
    } catch (error) {
      if (!res.headersSent) {
        jsonError(res, 500, error instanceof Error ? error.message : String(error));
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => resolve());
  });

  console.error(
    `play-console-mcp remote server listening on http://${host}:${port}${mcpPath} (public resource: ${broker.config.resource.toString()})`,
  );

  const shutdown = async () => {
    for (const session of sessions.values()) {
      await session.server.close().catch(() => undefined);
    }
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
}
