import {
  defaultOAuthTokenPath,
  deleteOAuthTokenRecord,
  loadOAuthClientConfig,
  loginWithGoogleOAuth,
  readOAuthTokenRecord,
} from "./play/oauth.js";
import { remoteSecret } from "./remote/config.js";

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function authHelp(): string {
  return `Google Play Console OAuth commands:

  play-console-mcp auth login --client /path/to/client_secret.json
  play-console-mcp auth status
  play-console-mcp auth logout
  play-console-mcp auth path

Login options:
  --client PATH       Google OAuth Desktop client JSON
  --token PATH        Override the local token file
  --port PORT         Fixed loopback callback port
  --redirect-uri URI  Exact loopback URI (mainly for a Web OAuth client)
  --no-browser        Print the URL without opening a browser
`;
}

function remoteHelp(): string {
  return `Remote ChatGPT/Codex server commands:

  play-console-mcp serve --http   Start Streamable HTTP + OAuth broker
  play-console-mcp remote secret  Generate an MCP_OAUTH_SECRET

Remote mode requires MCP_PUBLIC_URL, MCP_OAUTH_SECRET, a Google Web OAuth client,
and either GOOGLE_OAUTH_ALLOWED_EMAILS or MCP_OAUTH_ALLOW_ANY_GOOGLE_ACCOUNT=1.
See docs/OPENAI.md for the complete setup.
`;
}

export function mainHelp(): string {
  return `play-console-mcp

Usage:
  play-console-mcp                 Start the MCP server over stdio
  play-console-mcp serve           Start the MCP server over stdio
  play-console-mcp serve --http    Start the remote Streamable HTTP server
  play-console-mcp auth <command>  Manage local Google OAuth credentials
  play-console-mcp remote <cmd>    Remote-server utilities
  play-console-mcp --help          Show this help

The no-argument behavior remains stdio for Claude, Codex and other local MCP clients.
`;
}

export async function runAuthCommand(args: string[]): Promise<void> {
  const command = args[0] ?? "help";
  const tokenPath = optionValue(args, "--token") ?? defaultOAuthTokenPath();

  switch (command) {
    case "login": {
      const client = await loadOAuthClientConfig({ path: optionValue(args, "--client") });
      const portText = optionValue(args, "--port");
      const port = portText === undefined ? undefined : Number(portText);
      if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
        throw new Error("--port must be an integer between 0 and 65535.");
      }

      console.log("The browser will ask only for Google Play Console API scopes.");
      const record = await loginWithGoogleOAuth({
        client,
        tokenPath,
        port,
        redirectUri: optionValue(args, "--redirect-uri"),
        openBrowser: !hasFlag(args, "--no-browser"),
        onAuthorizationUrl: (url) => {
          console.log(`Open this URL to authorize Google Play Console access:\n${url}\n`);
        },
      });
      console.log(`OAuth login saved to ${tokenPath}`);
      console.log(`Granted scopes: ${record.scopes.join(", ")}`);
      return;
    }
    case "status": {
      const record = await readOAuthTokenRecord(tokenPath);
      console.log(`OAuth token file: ${tokenPath}`);
      console.log(`Client ID: ${record.clientId}`);
      console.log(`Scopes: ${record.scopes.join(", ")}`);
      console.log(`Updated: ${record.updatedAt}`);
      console.log(
        record.expiresAt
          ? `Cached access token expires: ${new Date(record.expiresAt).toISOString()}`
          : "No cached access token; it will be refreshed on the next API call.",
      );
      return;
    }
    case "logout": {
      const removed = await deleteOAuthTokenRecord(tokenPath);
      console.log(removed ? `Removed ${tokenPath}` : `No OAuth token found at ${tokenPath}`);
      return;
    }
    case "path":
      console.log(tokenPath);
      return;
    case "help":
    case "--help":
    case "-h":
      console.log(authHelp());
      return;
    default:
      throw new Error(`Unknown auth command '${command}'.\n\n${authHelp()}`);
  }
}

export async function runRemoteCommand(args: string[]): Promise<void> {
  const command = args[0] ?? "help";
  switch (command) {
    case "secret":
      console.log(remoteSecret());
      return;
    case "help":
    case "--help":
    case "-h":
      console.log(remoteHelp());
      return;
    default:
      throw new Error(`Unknown remote command '${command}'.\n\n${remoteHelp()}`);
  }
}
