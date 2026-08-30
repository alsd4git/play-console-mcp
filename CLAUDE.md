# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## What this is

An MCP server for the **Google Play Developer API** (`androidpublisher` v3) and **Play Developer Reporting API** (`v1beta1`). It focuses on Play Store reviews, release/track management, localized listings and Android vitals.

This fork keeps the upstream `stdio` server and adds optional local Google OAuth, tool-policy profiles, OpenAI/Codex packaging and a separate Streamable HTTP + OAuth broker for persistent ChatGPT/Codex app connections.

APK/AAB upload is intentionally out of scope. CI or Play Console uploads signed artifacts; the MCP may inspect their metadata and operate on their version codes.

## Commands

```bash
npm run build
npm test
npm run test:watch
npm run lint
npm run typecheck
npm run format
npm run format:check
```

Run a single test file or pattern:

```bash
npx vitest run src/__tests__/releases.test.ts
npx vitest run src/__tests__/remote-oauth.test.ts
npx vitest run -t "promote_release"
```

CI runs format, lint, typecheck, tests and build on supported Node versions.

## Entry points

`src/index.ts` is the executable entry point and dispatches without importing local credential configuration unnecessarily.

```text
no args / serve / --stdio
        -> local stdio MCP
        -> src/config.ts
        -> service account or locally persisted Google OAuth

serve --http / --http
        -> remote Streamable HTTP MCP
        -> src/remote/*
        -> per-user brokered Google OAuth
```

The no-argument behavior must remain `stdio` for upstream/Claude compatibility.

## Local authentication

- **`src/config.ts`** resolves `GOOGLE_PLAY_AUTH_MODE=auto|oauth|service-account`. In `auto`, a configured service account wins; otherwise local OAuth is used.
- **`src/play/auth.ts`** implements the original service-account JWT exchange and token cache.
- **`src/play/oauth.ts`** implements local Google Authorization Code + PKCE, protected token-file persistence and refresh-token exchange.
- **`src/play/client.ts`** is the shared thin HTTP client for Android Publisher and Developer Reporting APIs.

Local OAuth state is user-owned filesystem state. Never log or expose service-account keys, Google access tokens or refresh tokens.

## Remote app mode

Remote app mode is intentionally a separate authorization boundary. Never turn it into Google-token passthrough.

```text
ChatGPT/Codex -- MCP token --> play-console-mcp -- Google token --> Google Play APIs
```

- **`src/remote/config.ts`** validates HTTPS/public URL configuration, Google Web OAuth settings, private account allowlisting and server secrets.
- **`src/remote/store.ts`** persists dynamic MCP client registrations and Google identities. Google refresh tokens are AES-256-GCM encrypted at rest. MCP access/refresh tokens are not stored.
- **`src/remote/oauth.ts`** implements protected-resource metadata, authorization-server metadata, dynamic client registration, Authorization Code + PKCE, Google login brokerage and MCP access/refresh JWTs.
- **`src/remote/http.ts`** authenticates every request, creates per-user `GooglePlayClient` instances and connects `McpServer` instances through `StreamableHTTPServerTransport`.

Remote OAuth principles:

- MCP bearer tokens are audience-bound to `MCP_PUBLIC_URL` and must never be forwarded to Google.
- Google access tokens are short lived and created server-side from the connected user's encrypted refresh token.
- `GOOGLE_OAUTH_ALLOWED_EMAILS` is the normal private-server mode. Accepting arbitrary Google accounts requires an explicit operator opt-in.
- HTTP binds to loopback by default; non-loopback binds require explicit opt-in.
- OAuth issuer is an origin, not a nested path.
- Authorization codes/transactions are short-lived in-memory state.
- Keep request/session/client-registration bounds conservative; remote endpoints are Internet-facing when deployed.

## Tool policy

**`src/tool-policy.ts`** wraps tool registration centrally so upstream tool modules do not need OpenAI-specific branches.

Profiles:

- `full` — normal read/write surface;
- `readonly` — explicit fail-closed allowlist of reviewed non-mutating tools.

MCP OAuth scopes in remote mode map to profiles:

- `play.read` -> `readonly`;
- `play.read play.write` -> `full`.

Tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) are applied centrally.

`GOOGLE_PLAY_ALLOWED_PACKAGES` is an independent defense-in-depth layer. When it is set, package-specific calls are checked and `list_apps` is hidden.

## Write scope

Standard writes are intentionally supported:

- public review replies;
- release creation/promotion using already-uploaded version codes;
- rollout state/percentage changes;
- release-note updates;
- track and tester-group changes;
- store-listing text and app-detail updates.

Deletes, listing-image uploads and recovery writes remain behind `GOOGLE_PLAY_ALLOW_DESTRUCTIVE=1` in addition to requiring a full/write-capable session.

Do **not** add APK/AAB/deobfuscation uploads unless the project scope is explicitly changed. The current design keeps artifact upload in CI.

## Play edits workflow

**`src/play/edits.ts`** implements:

- `readWithEdit`: insert temporary edit -> read -> always delete, never commit;
- `withEdit`: insert -> mutate -> validate+delete for dry-run or commit; delete on failure.

Some semantic reads therefore issue HTTP `POST`/`DELETE`. Do not implement read-only security by HTTP verb. The tool allowlist is the authorization boundary.

Every write tool using edits must retain `validate_only` support where the API allows it.

## Tool modules

`src/tools/*.ts` register domain-specific MCP tools:

- `reviews.ts`
- `releases.ts`
- `listings.ts`
- `artifacts.ts`
- `recovery.ts`
- `vitals.ts`
- `apps.ts`

Keep Google responses largely pass-through rather than fabricating rigid response models. Every package-specific tool takes optional `package_name`, resolved against the configured default.

`src/tools/shared.ts` owns shared Zod shapes such as `packageArg`, `writeShape` and release-note schemas.

## TypeScript conventions

- ESM + Node16 resolution: relative imports end in `.js` even from `.ts` sources.
- Tool arguments are snake_case and should have agent-facing `.describe(...)` text.
- Tool handlers follow the existing try/catch + `ok`/`err` envelope style.
- Keep the individual upstream tool modules independent from transport/provider-specific logic whenever possible.
- Never log credentials or bearer tokens.
- The repository is public; credential/state files belong outside Git and are ignored.

## Tests

Existing tool tests capture registered handlers with fake MCP servers, use fake token providers and stub `fetch` to assert exact Google API traffic and edits ordering.

Important suites:

- `auth.test.ts` — service-account JWT exchange/cache;
- `oauth.test.ts` — local Google OAuth persistence/refresh;
- `tool-policy.test.ts` — readonly/full policy, annotations and package allowlisting;
- `releases.test.ts` / `listings.test.ts` — Play edits behavior;
- `remote-oauth.test.ts` — remote configuration/PKCE/redirect safety.

When modifying remote auth, add tests for security invariants rather than only happy-path HTTP behavior.
