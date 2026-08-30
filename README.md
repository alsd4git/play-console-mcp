# play-console-mcp

[![CI](https://github.com/alsd4git/play-console-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/alsd4git/play-console-mcp/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

MCP server for the **Google Play Console**, built on the official Google Play Developer API and Play Developer Reporting API.

It can inspect reviews, localized Store listings, releases, testing tracks, uploaded artifacts, recovery actions, crash/ANR reports, memory metrics and battery vitals. The existing release and listing write tools remain available in the full profile, while Codex and ChatGPT integrations use a fail-closed read-only profile by default.

This fork extends [`OrellBuehler/play-console-mcp`](https://github.com/OrellBuehler/play-console-mcp) without changing its default `stdio` behavior:

- Google user OAuth with Authorization Code + PKCE and local refresh-token storage;
- a real `readonly` tool profile based on an explicit allowlist;
- MCP tool annotations for clients such as Codex and ChatGPT;
- optional package-name allowlisting;
- Codex/OpenAI plugin metadata;
- documented use through ChatGPT Secure MCP Tunnel;
- unchanged service-account and Claude configuration paths.

> **Deliberate scope:** no AAB/APK upload. Upload signed artifacts from CI or Play Console, then use this server to inspect or manage their version codes.

## Quick start with your Google account

### 1. Create a Google OAuth client

In Google Cloud:

1. Enable **Google Play Android Developer API** and **Google Play Developer Reporting API**.
2. Configure an OAuth consent screen. For a private app in testing, add your own Google account as a test user.
3. Create an OAuth client of type **Desktop app** and download its JSON file.
4. Ensure the same Google account has access to the relevant apps in Play Console.

Authorize locally:

```bash
npx -y github:alsd4git/play-console-mcp \
  auth login --client /absolute/path/to/client_secret.json
```

The browser flow requests only:

```text
https://www.googleapis.com/auth/androidpublisher
https://www.googleapis.com/auth/playdeveloperreporting
```

It does **not** request Gmail, Drive, Calendar, profile, or general Google-account access. The refresh token stays in the operating-system configuration directory on the machine running the MCP server.

Check or remove the login:

```bash
npx -y github:alsd4git/play-console-mcp auth status
npx -y github:alsd4git/play-console-mcp auth path
npx -y github:alsd4git/play-console-mcp auth logout
```

### 2. Run the read-only server

```bash
GOOGLE_PLAY_PROFILE=readonly \
npx -y github:alsd4git/play-console-mcp
```

No arguments still means “start the MCP server over stdio”, preserving compatibility with the original project and Claude.

## Codex

The repository is an OpenAI/Codex plugin root. `.codex-plugin/plugin.json` references `.mcp.json`, which launches this fork and selects the read-only profile.

A manual Codex MCP entry is equivalent:

```toml
[mcp_servers.play_console]
command = "npx"
args = ["-y", "github:alsd4git/play-console-mcp"]
env = { GOOGLE_PLAY_PROFILE = "readonly" }
```

See [docs/OPENAI.md](./docs/OPENAI.md) for plugin and setup details.

## ChatGPT web

For private personal use, run this `stdio` server through **Secure MCP Tunnel** instead of exposing a public HTTP endpoint. Configure the tunnel to launch:

```json
{
  "command": "npx",
  "args": ["-y", "github:alsd4git/play-console-mcp"],
  "env": {
    "GOOGLE_PLAY_PROFILE": "readonly"
  }
}
```

Register the tunnel endpoint as a custom MCP app in ChatGPT Developer Mode. ChatGPT receives MCP results; the Google token remains on the tunnel host.

An `.app.json` is intentionally not committed: OpenAI assigns its app ID when the private or public app is registered. Adding that generated file later does not require changing the MCP server.

## Claude Code

The original service-account setup continues to work:

```bash
claude mcp add play-console \
  -e GOOGLE_SERVICE_ACCOUNT_KEY_PATH=/path/to/service-account.json \
  -e GOOGLE_PLAY_PACKAGE_NAME=com.example.app \
  -- npx -y github:alsd4git/play-console-mcp
```

Or use the usual MCP JSON:

```json
{
  "mcpServers": {
    "play-console": {
      "command": "npx",
      "args": ["-y", "github:alsd4git/play-console-mcp"],
      "env": {
        "GOOGLE_SERVICE_ACCOUNT_KEY_PATH": "/path/to/service-account.json",
        "GOOGLE_PLAY_PACKAGE_NAME": "com.example.app"
      }
    }
  }
}
```

Because `GOOGLE_PLAY_PROFILE` defaults to `full`, existing Claude configurations retain upstream behavior. Add `GOOGLE_PLAY_PROFILE=readonly` when only inspection is needed.

## Authentication modes

`GOOGLE_PLAY_AUTH_MODE` accepts:

| Mode | Behavior |
| --- | --- |
| `auto` (default) | Uses a configured service account; otherwise loads the local OAuth login |
| `oauth` | Requires the local Google user OAuth token |
| `service-account` | Requires service-account JSON |

### Service account

Set either:

```bash
export GOOGLE_SERVICE_ACCOUNT_KEY_PATH=/path/to/service-account.json
```

or:

```bash
export GOOGLE_SERVICE_ACCOUNT_KEY='{"type":"service_account",...}'
```

Invite the service-account email under **Play Console → Users and permissions** and grant only the permissions needed for the chosen profile. Keep the JSON outside the repository.

### OAuth storage

Default token locations:

- macOS: `~/Library/Application Support/play-console-mcp/google-oauth.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/play-console-mcp/google-oauth.json`
- Windows: `%APPDATA%\play-console-mcp\google-oauth.json`

Override with `GOOGLE_OAUTH_TOKEN_PATH`, for example when mounting a secret volume.

## Tool profiles

### `readonly`

Only explicitly classified non-mutating tools are registered. Mutating tools are absent from `tools/list` and rejected even if called by name. A future upstream tool is hidden until reviewed, so the profile fails closed.

Google requires temporary edits for some reads. The server may therefore issue a `POST` to create an edit and a `DELETE` to discard it while reading listings, tracks or artifacts; it never commits the edit. Read-only enforcement is semantic rather than a naive HTTP-verb filter.

### `full`

Preserves upstream behavior, including review replies, listing edits and release management. Delete operations, image uploads and recovery writes still require:

```bash
GOOGLE_PLAY_ALLOW_DESTRUCTIVE=1
```

For AI clients, use separate read-only and full MCP entries rather than changing one entry silently.

## Optional package allowlist

For defense in depth:

```bash
export GOOGLE_PLAY_ALLOWED_PACKAGES=com.example.app,com.example.second
```

Every package-specific tool rejects other package names. `list_apps` is hidden while the allowlist is active because it could reveal apps outside the approved set.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `GOOGLE_PLAY_AUTH_MODE` | no | `auto`, `oauth`, or `service-account` |
| `GOOGLE_OAUTH_TOKEN_PATH` | no | Override the locally stored OAuth token |
| `GOOGLE_OAUTH_CLIENT_CONFIG_PATH` | login | Downloaded Google OAuth client JSON |
| `GOOGLE_OAUTH_CLIENT_ID` | login | Alternative to a client JSON |
| `GOOGLE_OAUTH_CLIENT_SECRET` | no | OAuth client secret when supplied separately |
| `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` | one of | Path to service-account JSON |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | one of | Inline service-account JSON |
| `GOOGLE_PLAY_PACKAGE_NAME` | no | Default package name |
| `GOOGLE_PLAY_PROFILE` | no | `full` (compatible default) or `readonly` |
| `GOOGLE_PLAY_READ_ONLY` | no | Boolean alias that forces `readonly` |
| `GOOGLE_PLAY_ALLOWED_PACKAGES` | no | Comma-separated package allowlist |
| `GOOGLE_PLAY_ALLOW_DESTRUCTIVE` | no | Register delete, image-upload and recovery-write tools in `full` |

## Main tools

The read-only profile covers:

- `list_reviews` and `get_review`;
- release tracks, releases, country availability and testers;
- localized listings, app details and Store images;
- uploaded bundle/APK metadata, generated APKs and device-tier configurations;
- recovery-action status;
- app discovery and release filters;
- crash, ANR, error, low-memory, memory, slow start/rendering, wakeup and wakelock metrics.

The full profile additionally exposes review replies, listing updates, release creation/promotion, rollout management, release notes, tester changes and opt-in destructive/recovery operations.

## API limitations

- Review APIs return only written reviews from production releases that were created or modified in roughly the last seven days.
- Public review replies are capped at 350 characters.
- Ratings history is not exposed by the Developer Reporting API.
- Play Console UI sections without a public Google API cannot be reproduced by this server.
- OAuth API scopes are broad; effective read-only behavior comes from Play Console permissions and the MCP tool policy. See [docs/SECURITY.md](./docs/SECURITY.md).

## Development

```bash
git clone https://github.com/alsd4git/play-console-mcp.git
cd play-console-mcp
npm install
npm run format
npm run lint
npm run typecheck
npm test
npm run build
```

Test OAuth from the local build:

```bash
node dist/index.js auth login --client /path/to/client_secret.json
node dist/index.js auth status
```

Smoke-test the MCP server:

```bash
GOOGLE_PLAY_PROFILE=readonly \
npx @modelcontextprotocol/inspector node dist/index.js
```

## Upstream compatibility

The fork keeps the same no-argument `stdio` entry point, environment variables and default full tool surface as the original project. OAuth, profiles, annotations and OpenAI packaging are additive. This separation is intentional so generally useful changes can be proposed upstream later.

## License

MIT. Original project © Orell Bühler; fork additions © contributors.
