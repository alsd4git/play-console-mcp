# play-console-mcp

[![CI](https://github.com/alsd4git/play-console-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/alsd4git/play-console-mcp/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

MCP server for the **Google Play Console**, built on the official Google Play Developer API and Play Developer Reporting API.

It can inspect and manage Play Store reviews, localized listings, release tracks, release notes, tester groups and staged rollouts, and can query Android vitals such as crashes, ANRs, memory pressure and battery metrics.

This fork extends [`OrellBuehler/play-console-mcp`](https://github.com/OrellBuehler/play-console-mcp) while preserving the original no-argument `stdio` workflow for Claude and other local MCP clients.

## Scope

Supported today:

- read and reply to recent Play Store reviews;
- inspect and edit localized Store listing text and app details;
- inspect release tracks and already-uploaded version codes;
- create/promote releases from version codes uploaded elsewhere;
- update release notes and staged rollout state;
- inspect/update tester groups and tracks;
- inspect recovery actions;
- query Android vitals, anomalies, crash/ANR issues and reports;
- authenticate with a service account, local Google OAuth, or the remote per-user OAuth broker.

Deliberately **not implemented**:

- APK/AAB upload;
- deobfuscation-file upload;
- in-app products/subscriptions;
- Play Console user/permission management.

The intended artifact workflow remains: **CI uploads signed APK/AAB files; this MCP operates on the resulting Play Console state and version codes.**

## Integration modes

### 1. Local `stdio`

Best for Claude Code, Codex CLI or any MCP client that launches a local process.

```text
MCP client -> stdio -> play-console-mcp -> Google Play APIs
```

Authentication can use either a service account or a locally stored Google OAuth login.

### 2. Remote ChatGPT/Codex app mode

Designed for the familiar connected-app experience:

```text
Install/connect app
      -> Sign in with Google
      -> connection remains associated with the OpenAI app
      -> use from ChatGPT and Codex
```

The remote server is both an MCP resource server and an OAuth broker:

```text
ChatGPT / Codex
      |
      | MCP OAuth access token
      v
play-console-mcp
      |
      | short-lived Google access token
      v
Google Play APIs
```

The MCP bearer token is **not** a Google token and is never forwarded to Google. The server stores each connected user's Google refresh token encrypted and obtains Google access tokens only when making Play API calls.

See [docs/OPENAI.md](./docs/OPENAI.md) for the complete setup and [docs/SECURITY.md](./docs/SECURITY.md) for the security model.

## Quick start: local Google OAuth

In Google Cloud:

1. Enable **Google Play Android Developer API** and **Google Play Developer Reporting API**.
2. Configure the OAuth consent screen.
3. Create an OAuth client of type **Desktop app**.
4. Ensure the same Google account has access to the relevant Play Console apps.

Then run:

```bash
npx -y github:alsd4git/play-console-mcp \
  auth login --client /absolute/path/to/client_secret.json
```

The browser flow requests only:

```text
https://www.googleapis.com/auth/androidpublisher
https://www.googleapis.com/auth/playdeveloperreporting
```

Run the MCP server:

```bash
npx -y github:alsd4git/play-console-mcp
```

Useful OAuth commands:

```bash
npx -y github:alsd4git/play-console-mcp auth status
npx -y github:alsd4git/play-console-mcp auth path
npx -y github:alsd4git/play-console-mcp auth logout
```

## Claude Code

The original service-account path remains supported:

```bash
claude mcp add play-console \
  -e GOOGLE_SERVICE_ACCOUNT_KEY_PATH=/path/to/service-account.json \
  -e GOOGLE_PLAY_PACKAGE_NAME=com.example.app \
  -- npx -y github:alsd4git/play-console-mcp
```

Or configure it manually:

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

No arguments still means `stdio`, so existing Claude configurations remain compatible.

## Codex local plugin

The repository contains `.codex-plugin/plugin.json` and `.mcp.json`. The packaged local MCP now uses the `full` profile, so normal write tools are available as well as reads.

Equivalent manual configuration:

```toml
[mcp_servers.play_console]
command = "npx"
args = ["-y", "github:alsd4git/play-console-mcp"]
env = { GOOGLE_PLAY_PROFILE = "full" }
```

Set `GOOGLE_PLAY_PROFILE=readonly` when a local connection should expose inspection tools only.

## Remote app mode

Remote mode uses **Streamable HTTP** and a per-user OAuth connection suitable for a private ChatGPT app.

### Google Cloud setup

Create a Google OAuth client of type **Web application** and add the callback URL of the MCP deployment, for example:

```text
https://play-mcp.example.com/oauth/google/callback
```

The remote flow requests:

```text
openid
email
https://www.googleapis.com/auth/androidpublisher
https://www.googleapis.com/auth/playdeveloperreporting
```

### Server setup

Generate a high-entropy server secret:

```bash
npx -y github:alsd4git/play-console-mcp remote secret
```

Example private deployment:

```bash
export MCP_PUBLIC_URL=https://play-mcp.example.com/mcp
export MCP_OAUTH_SECRET='<generated secret>'
export GOOGLE_OAUTH_CLIENT_CONFIG_PATH=/secrets/google-web-client.json
export GOOGLE_OAUTH_ALLOWED_EMAILS=you@example.com
export GOOGLE_PLAY_ALLOWED_PACKAGES=com.example.app,com.example.second

npx -y github:alsd4git/play-console-mcp serve --http
```

The process listens on `127.0.0.1:8787` by default. Put a trusted HTTPS reverse proxy or tunnel in front of it.

Remote access is **closed by default**. Use `GOOGLE_OAUTH_ALLOWED_EMAILS` for a personal deployment. A deliberately multi-user deployment must opt in with:

```bash
MCP_OAUTH_ALLOW_ANY_GOOGLE_ACCOUNT=1
```

Binding Node itself to a non-loopback address also requires:

```bash
MCP_HTTP_ALLOW_PUBLIC_BIND=1
```

The default concurrent MCP session limit is 100 and can be changed with `MCP_HTTP_MAX_SESSIONS`.

### OAuth/MCP endpoints

For `MCP_PUBLIC_URL=https://play-mcp.example.com/mcp`, the server exposes:

```text
GET  /.well-known/oauth-protected-resource/mcp
GET  /.well-known/oauth-authorization-server
POST /oauth/register
GET  /oauth/authorize
POST /oauth/token
GET  /oauth/google/callback
POST /mcp
GET  /healthz
```

The MCP authorization layer supports Authorization Code + PKCE, dynamic client registration, `play.read`, `play.write`, and `offline_access`.

A connection with `play.write` gets the `full` tool profile. A connection with only `play.read` gets the fail-closed `readonly` profile.

After registering the remote endpoint as a custom app in ChatGPT Developer Mode, complete the Google login once. When OpenAI assigns the app a real `asdk_app_...` ID, an `.app.json` can be added to this repository so the plugin references that registered app instead of inventing an ID beforehand.

### Secure MCP Tunnel

Secure MCP Tunnel remains a good option for the pre-authenticated local/stdio workflow.

The brokered remote OAuth workflow additionally needs the OAuth discovery, authorization, token and Google callback routes reachable on the same public origin as `/mcp`. Use Secure MCP Tunnel for that mode only when its configuration forwards those companion HTTP routes; otherwise use an HTTPS reverse proxy or tunnel that does.

## Write access

Normal writes are enabled in the `full` profile:

- `reply_to_review`;
- store listing and app-detail updates;
- release creation and promotion using version codes already uploaded by CI;
- release-note updates;
- rollout update/halt/resume/complete operations;
- track creation and tester-group updates.

Write tools that use Play's edits workflow retain `validate_only` where provided by the original server.

Higher-risk existing operations remain a separate operator opt-in:

```bash
GOOGLE_PLAY_ALLOW_DESTRUCTIVE=1
```

That flag enables the existing delete, listing-image upload and recovery-write surface. It does **not** add APK/AAB upload support.

## Tool profiles

### `full`

Preserves the upstream write surface and is the packaged plugin default.

### `readonly`

Only explicitly classified non-mutating tools are exposed. New upstream tools remain hidden until classified, so the profile fails closed.

Some Google Play reads require a temporary Play edit. The server may therefore create and delete an **uncommitted** temporary edit while reading listings/tracks. It never commits that read edit; read-only enforcement is semantic rather than a naive HTTP-method filter.

## Package allowlist

For defense in depth:

```bash
export GOOGLE_PLAY_ALLOWED_PACKAGES=com.example.app,com.example.second
```

Package-specific tools reject other app IDs. `list_apps` is hidden while this allowlist is enabled because it could reveal apps outside the approved set.

## Configuration

### Local authentication

| Variable | Description |
| --- | --- |
| `GOOGLE_PLAY_AUTH_MODE` | `auto`, `oauth`, or `service-account` |
| `GOOGLE_OAUTH_TOKEN_PATH` | Override local OAuth token storage |
| `GOOGLE_OAUTH_CLIENT_CONFIG_PATH` | Google OAuth client JSON |
| `GOOGLE_OAUTH_CLIENT_ID` | OAuth client ID when not using a JSON file |
| `GOOGLE_OAUTH_CLIENT_SECRET` | OAuth client secret |
| `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` | Service-account JSON path |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Inline service-account JSON |

### Play tool policy

| Variable | Description |
| --- | --- |
| `GOOGLE_PLAY_PACKAGE_NAME` | Default package name |
| `GOOGLE_PLAY_PROFILE` | `full` or `readonly` |
| `GOOGLE_PLAY_READ_ONLY` | Boolean alias forcing `readonly` |
| `GOOGLE_PLAY_ALLOWED_PACKAGES` | Comma-separated package allowlist |
| `GOOGLE_PLAY_ALLOW_DESTRUCTIVE` | Enables delete/image/recovery writes in `full` |

### Remote app mode

| Variable | Description |
| --- | --- |
| `MCP_PUBLIC_URL` | Public HTTPS MCP resource URL, normally ending in `/mcp` |
| `MCP_OAUTH_SECRET` | Server token/encryption master secret |
| `MCP_OAUTH_ISSUER` | Optional OAuth issuer origin; defaults to `MCP_PUBLIC_URL` origin |
| `MCP_OAUTH_DATA_PATH` | Persistent encrypted remote OAuth state file |
| `GOOGLE_OAUTH_ALLOWED_EMAILS` | Comma-separated Google-account allowlist |
| `MCP_OAUTH_ALLOW_ANY_GOOGLE_ACCOUNT` | Explicit opt-in for arbitrary Google accounts |
| `GOOGLE_OAUTH_REDIRECT_URI` | Optional explicit Google Web OAuth callback URI |
| `MCP_HTTP_HOST` | Local listener host, default `127.0.0.1` |
| `MCP_HTTP_PORT` | Local listener port, default `8787` |
| `MCP_HTTP_MAX_SESSIONS` | Concurrent MCP session limit, default `100` |
| `MCP_HTTP_ALLOW_PUBLIC_BIND` | Required to bind Node to a non-loopback address |
| `MCP_ALLOW_INSECURE_HTTP` | Development-only insecure HTTP override |

See [.env.example](./.env.example) for a commented configuration template.

## Google/API limitations

- Google does not provide a narrower read-only Android Publisher OAuth scope; tool policy and Play Console permissions provide the effective authorization boundary.
- Review APIs return only written reviews from production releases created or modified within Google's recent-review window.
- Public developer replies are capped by Google Play.
- Ratings history and some Play Console UI sections are not exposed by the public APIs.
- Android vitals data is aggregated and may lag behind real time.

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

Local MCP smoke test:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

Remote server:

```bash
node dist/index.js serve --http
```

## Upstream compatibility

The fork keeps the original `stdio` entry point, service-account workflow and existing Google Play tool modules. Local OAuth, tool profiles, MCP annotations, OpenAI packaging and remote OAuth/HTTP support are additive layers around that core. This is intentional so generally useful pieces can still be proposed upstream independently.

## License

MIT. Original project © Orell Bühler; fork additions © contributors.
