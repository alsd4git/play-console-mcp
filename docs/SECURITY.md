# Security model

## Credential modes

The server supports three credential patterns:

- service-account JSON for the original/headless workflow;
- local Google OAuth for `stdio` clients;
- brokered per-user OAuth for the remote ChatGPT/Codex app mode.

Secrets are never committed to the repository.

## Local OAuth

Local OAuth refresh tokens are stored in the operating-system configuration directory and are never sent to Codex, ChatGPT, Claude, or a tunnel provider. The MCP process exchanges them directly with Google's token endpoint.

Default token locations:

- macOS: `~/Library/Application Support/play-console-mcp/google-oauth.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/play-console-mcp/google-oauth.json`
- Windows: `%APPDATA%\play-console-mcp\google-oauth.json`

The directory is created with owner-only permissions where POSIX modes are available and updates use a temporary file followed by rename.

## Remote OAuth broker

Remote mode intentionally separates the two authorization boundaries:

```text
ChatGPT/Codex -- MCP access token --> play-console-mcp -- Google access token --> Google Play APIs
```

The MCP bearer token is issued by this server, is audience-bound to `MCP_PUBLIC_URL`, and is never forwarded to Google. Google access tokens are obtained independently from the Google refresh token associated with the authenticated user.

The remote flow uses:

- OAuth Authorization Code;
- PKCE with `S256`;
- RFC 9728 protected-resource metadata;
- authorization-server discovery metadata;
- public-client dynamic registration for compatibility with current MCP clients;
- `offline_access` and signed MCP refresh tokens;
- separate `play.read` and `play.write` scopes.

Google login requests only OpenID identity/email plus Android Publisher and Play Developer Reporting API scopes.

### Stored remote state

The remote store contains:

- dynamically registered MCP client IDs and redirect URIs;
- Google subject/email identifiers;
- Google refresh tokens encrypted with AES-256-GCM.

MCP access and refresh tokens are signed tokens and are not persisted in the state file. Authorization codes and Google-login transactions exist only in memory and expire quickly.

`MCP_OAUTH_SECRET` is used through separate derivation contexts for token signing and Google refresh-token encryption. Keep it stable and secret. Rotating or losing it intentionally invalidates existing MCP refresh tokens and makes the encrypted Google credentials unreadable; users must reconnect.

## Private-server defaults

Remote OAuth is closed unless one of these is set:

```bash
GOOGLE_OAUTH_ALLOWED_EMAILS=you@example.com
```

or, for a deliberately multi-user deployment:

```bash
MCP_OAUTH_ALLOW_ANY_GOOGLE_ACCOUNT=1
```

For a personal server, use the email allowlist.

The Streamable HTTP listener defaults to `127.0.0.1`. Binding to a non-loopback address requires an additional explicit opt-in:

```bash
MCP_HTTP_ALLOW_PUBLIC_BIND=1
```

`MCP_PUBLIC_URL` and the OAuth issuer require HTTPS except for explicit loopback/development configurations. In production, terminate TLS at a trusted reverse proxy or tunnel and keep the Node listener on loopback when possible.

## Google API scope limitation

Google does not provide a narrower read-only Android Publisher OAuth scope. Effective safety therefore comes from independent layers:

1. Play Console permissions assigned to the Google identity.
2. MCP authorization scope (`play.read` versus `play.write`).
3. The fail-closed `readonly` MCP tool profile when write scope is absent.
4. Optional `GOOGLE_PLAY_ALLOWED_PACKAGES` package allowlisting.
5. Separate server opt-in for the highest-risk existing tools via `GOOGLE_PLAY_ALLOW_DESTRUCTIVE=1`.

A newly added upstream tool remains hidden from the `readonly` profile until explicitly classified.

## Write actions

`play.write` exposes normal write operations such as public review replies, listing text changes, release/rollout management, release-note updates and tester changes.

Delete/listing-image/recovery-write tools remain disabled unless the operator sets:

```bash
GOOGLE_PLAY_ALLOW_DESTRUCTIVE=1
```

Tools using the Google Play edits workflow retain their `validate_only` dry-run option where the original server provides it. MCP annotations also identify read-only/destructive/idempotent behavior for clients that use those hints.

APK/AAB upload is not implemented by this project; CI remains the intended artifact-upload boundary.

## Temporary edits used by reads

Several Android Publisher read endpoints require an edit ID. The server may create and delete an uncommitted temporary edit while reading listings, tracks, artifacts, or related resources. The read path never commits that edit. Read-only enforcement is therefore semantic rather than an HTTP-method filter.

## Network exposure and tunnels

Secure MCP Tunnel is a good fit for the pre-authenticated local mode. Brokered remote OAuth additionally needs its OAuth discovery, authorization, token and Google callback paths reachable on the same origin as the MCP resource. If a tunnel product exposes only the MCP channel, use a reverse proxy/tunnel that forwards all required paths instead.

Regardless of transport, do not expose the remote server without OAuth, TLS, an account policy, and sensible infrastructure-level logging/rate limiting.
