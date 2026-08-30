# Codex and ChatGPT setup

This fork supports two OpenAI integration modes:

1. **Local/stdin mode** for Claude, Codex CLI and Secure MCP Tunnel. Google credentials stay on the machine and are prepared before the MCP client connects.
2. **Remote app mode** for a YouTrack-like `Connect → sign in with Google → use from ChatGPT/Codex` experience. The MCP server exposes Streamable HTTP plus its own OAuth 2.1-compatible authorization layer and brokers a separate Google OAuth connection per user.

APK/AAB uploads are deliberately not implemented. Signed artifacts should continue to come from CI or Play Console.

## Local mode

### Authorize your Google account

Create a Google OAuth client of type **Desktop app**, enable the Google Play Android Developer API and Play Developer Reporting API, then run:

```bash
npx -y github:alsd4git/play-console-mcp \
  auth login --client /absolute/path/to/client_secret.json
```

The loopback flow requests only the Android Publisher and Play Developer Reporting scopes and stores the Google refresh token on the MCP host.

Useful commands:

```bash
npx -y github:alsd4git/play-console-mcp auth status
npx -y github:alsd4git/play-console-mcp auth path
npx -y github:alsd4git/play-console-mcp auth logout
```

### Codex local plugin

The repository plugin root points to `.mcp.json`. The packaged local profile now exposes the normal write tools as well as reads:

```toml
[mcp_servers.play_console]
command = "npx"
args = ["-y", "github:alsd4git/play-console-mcp"]
env = { GOOGLE_PLAY_PROFILE = "full" }
```

This includes review replies, store-listing updates, release/rollout management, release notes and tester changes. Delete operations, listing-image uploads and recovery writes remain off unless the server operator explicitly sets `GOOGLE_PLAY_ALLOW_DESTRUCTIVE=1`.

## Remote app mode

Remote mode is intended to behave like a conventional connected ChatGPT app. ChatGPT/Codex authenticates to **this MCP server**, not directly to Google. During the MCP authorization flow the server redirects the user to Google, stores the resulting Google refresh token encrypted, and then issues separate MCP access/refresh tokens to the OpenAI client.

This separation is intentional: the bearer token accepted by the MCP endpoint is audience-bound to the MCP resource and is never forwarded to Google.

### 1. Create a Google Web OAuth client

In Google Cloud:

1. Enable **Google Play Android Developer API** and **Google Play Developer Reporting API**.
2. Configure the OAuth consent screen.
3. Create an OAuth client of type **Web application**.
4. Add your server callback URL, for example:

```text
https://play-mcp.example.com/oauth/google/callback
```

5. Ensure the Google account that will connect has the required Play Console permissions.

Remote mode asks Google for:

```text
openid
email
https://www.googleapis.com/auth/androidpublisher
https://www.googleapis.com/auth/playdeveloperreporting
```

It does not request Gmail, Drive or Calendar access.

### 2. Configure the server

Generate a server secret:

```bash
npx -y github:alsd4git/play-console-mcp remote secret
```

A private single-user example:

```bash
export MCP_PUBLIC_URL=https://play-mcp.example.com/mcp
export MCP_OAUTH_SECRET='<generated secret>'
export GOOGLE_OAUTH_CLIENT_CONFIG_PATH=/secrets/google-web-client.json
export GOOGLE_OAUTH_ALLOWED_EMAILS=you@example.com
export GOOGLE_PLAY_ALLOWED_PACKAGES=com.example.app,com.example.second

npx -y github:alsd4git/play-console-mcp serve --http
```

The HTTP listener defaults to `127.0.0.1:8787`; put an HTTPS reverse proxy or tunnel in front of it. Binding the MCP process itself to a non-loopback address additionally requires:

```bash
MCP_HTTP_ALLOW_PUBLIC_BIND=1
```

Remote access is closed by default. Either set `GOOGLE_OAUTH_ALLOWED_EMAILS` or deliberately opt into a multi-user server with:

```bash
MCP_OAUTH_ALLOW_ANY_GOOGLE_ACCOUNT=1
```

For personal use, prefer the email allowlist.

### 3. What the OAuth endpoints expose

With `MCP_PUBLIC_URL=https://play-mcp.example.com/mcp`, the server exposes:

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

The authorization server supports Authorization Code + PKCE, dynamic client registration for compatibility, `play.read`, `play.write`, and `offline_access`. `offline_access` produces a long-lived MCP refresh token so the OpenAI connection can survive ordinary access-token expiry and server restarts.

The default requested MCP scopes include both `play.read` and `play.write`. A client that connects with only `play.read` gets the existing fail-closed read-only tool profile.

### 4. Register it in ChatGPT

In ChatGPT Developer Mode, create a custom app using the public `/mcp` endpoint and OAuth. During tool scanning, ChatGPT should discover the protected-resource and authorization-server metadata, then present the Google sign-in flow.

After OpenAI assigns the app an `asdk_app_...` identifier, the repository can gain an `.app.json` containing that real app ID. Do not commit a fabricated app ID beforehand.

Once the app connection exists, a plugin can reference the registered app so ChatGPT and Codex use the same connected account rather than each launching a separate local process.

## Secure MCP Tunnel

Secure MCP Tunnel remains useful for the **local/pre-authenticated** mode: it can connect OpenAI products to a private local MCP without exposing that server directly.

The new brokered OAuth mode also needs its discovery, authorization, token, and Google callback routes reachable on the same public origin as the MCP resource. Only use Secure MCP Tunnel for this mode if the tunnel configuration you are using forwards those companion HTTP routes as well as `/mcp`; otherwise use an HTTPS reverse proxy/tunnel that does. The MCP server itself can still listen only on `127.0.0.1`.

## Write behavior

Standard writes are enabled in the packaged `full` profile:

- reply to/edit a public Play Store review reply;
- update localized store listing text and app details;
- create/promote releases from version codes already uploaded by CI;
- update release notes and rollout percentage;
- halt/resume/complete staged rollouts;
- create tracks and update tester groups.

The server still does **not** upload APK/AAB artifacts.

More dangerous operations remain a separate server-side opt-in:

```bash
GOOGLE_PLAY_ALLOW_DESTRUCTIVE=1
```

That flag enables the existing delete/listing-image/recovery-write surface. Edit-based write tools continue to support `validate_only` where the upstream project supports it.
