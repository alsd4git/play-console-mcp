# Codex and ChatGPT setup

This fork keeps the original `stdio` MCP interface. Claude, Codex, the OpenAI plugin package, and Secure MCP Tunnel can therefore all launch the same process.

## 1. Authorize your Google account

Create an OAuth client in Google Cloud:

1. Enable **Google Play Android Developer API** and **Google Play Developer Reporting API**.
2. Configure the OAuth consent screen. For a private app in testing, add your own Google account as a test user.
3. Create an OAuth client of type **Desktop app** and download its JSON file.
4. Ensure that the same Google account has the required app permissions in Play Console.

Then run:

```bash
npx -y github:alsd4git/play-console-mcp \
  auth login --client /absolute/path/to/client_secret.json
```

The command starts a loopback callback on `127.0.0.1`, opens Google's authorization page, uses Authorization Code + PKCE, and stores the refresh token in the operating-system configuration directory. It requests only these scopes:

- `https://www.googleapis.com/auth/androidpublisher`
- `https://www.googleapis.com/auth/playdeveloperreporting`

It does not request Gmail, Drive, Calendar, profile, or general Google-account access.

Useful commands:

```bash
npx -y github:alsd4git/play-console-mcp auth status
npx -y github:alsd4git/play-console-mcp auth path
npx -y github:alsd4git/play-console-mcp auth logout
```

For a machine without a usable browser, add `--no-browser` and open the printed URL on the same machine/session. A service account remains the simpler choice for a fully headless server.

## 2. Codex

The repository is a Codex/OpenAI plugin root: `.codex-plugin/plugin.json` points to `.mcp.json`, which launches this fork through `npx` and sets `GOOGLE_PLAY_PROFILE=readonly`.

A manual Codex configuration is equivalent:

```toml
[mcp_servers.play_console]
command = "npx"
args = ["-y", "github:alsd4git/play-console-mcp"]
env = { GOOGLE_PLAY_PROFILE = "readonly" }
```

Restart Codex after changing its MCP configuration, then ask it to list apps, inspect reviews, check tracks, read listings, or query Android vitals.

## 3. ChatGPT web through Secure MCP Tunnel

Secure MCP Tunnel can launch a local `stdio` server, so this project does not need to expose a public HTTP port. Configure the tunnel with the same process definition:

```json
{
  "command": "npx",
  "args": ["-y", "github:alsd4git/play-console-mcp"],
  "env": {
    "GOOGLE_PLAY_PROFILE": "readonly"
  }
}
```

The resulting private tunnel endpoint can be registered as a custom MCP app in ChatGPT Developer Mode. The Google refresh token remains on the machine running the tunnel; ChatGPT receives only MCP tool results.

Do not add a fabricated `.app.json` to this repository. OpenAI assigns the app ID when the private or published app is registered; that generated ID can be added later without changing the MCP server.

## 4. Enabling writes deliberately

The plugin defaults to read-only. To expose the upstream write tools, run the server with:

```bash
GOOGLE_PLAY_PROFILE=full npx -y github:alsd4git/play-console-mcp
```

The more dangerous delete, image-upload, and recovery-write tools additionally require:

```bash
GOOGLE_PLAY_ALLOW_DESTRUCTIVE=1
```

Use a separate MCP entry for write access rather than silently changing the read-only entry. This makes client approvals and audit history easier to understand.
