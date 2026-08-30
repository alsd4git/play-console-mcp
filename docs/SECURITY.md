# Security model

## Credentials

OAuth refresh tokens are stored locally and never sent to Codex, ChatGPT, Claude, or a tunnel provider. The MCP process exchanges them directly with Google's token endpoint and sends Google API responses back as tool results.

Default token locations:

- macOS: `~/Library/Application Support/play-console-mcp/google-oauth.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/play-console-mcp/google-oauth.json`
- Windows: `%APPDATA%\play-console-mcp\google-oauth.json`

The directory is created with owner-only permissions where the operating system supports POSIX modes, and token updates use a temporary file followed by rename. Override the location with `GOOGLE_OAUTH_TOKEN_PATH` when using a secret volume.

Service-account JSON and downloaded OAuth client files are ignored by Git. Never commit either one.

## OAuth scope limitation

Google does not provide a narrower read-only Android Publisher scope. OAuth therefore grants the API scope, while effective safety comes from three independent layers:

1. Play Console permissions assigned to the Google user or service account.
2. `GOOGLE_PLAY_PROFILE=readonly`, which exposes only an explicit allowlist of non-mutating MCP tools.
3. Optional `GOOGLE_PLAY_ALLOWED_PACKAGES`, which rejects package names outside an explicit allowlist and hides `list_apps`.

The read-only policy is fail-closed: a new upstream tool is hidden until classified in `src/tool-policy.ts`.

## Temporary edits used by reads

Several Android Publisher read endpoints require an edit ID. The server may create and delete an uncommitted temporary edit while reading listings, tracks, artifacts, or related resources. The read path never commits that edit. For this reason, read-only enforcement is semantic and cannot be implemented by blocking every HTTP `POST` or `DELETE` request.

## Network exposure

For personal ChatGPT usage, prefer Secure MCP Tunnel over a publicly reachable MCP server. The tunnel launches the local `stdio` process and keeps credentials on the local host.

If deploying a remote server later, add transport authentication, TLS, request limits, per-user credential isolation, audit logging, and an explicit tenant model before exposing it to the Internet.
