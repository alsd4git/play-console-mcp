# Privacy

This repository is open-source software and does not include a hosted service, telemetry, analytics, advertising, or a developer-operated credential collector.

When you run it locally, Google OAuth refresh tokens or service-account credentials remain on the machine running the MCP server and are sent only to Google's authentication endpoints. Google Play API responses are returned to the MCP client selected by the operator, such as Claude or Codex, or to ChatGPT through a private connection.

The optional remote app mode is also self-hosted. In that mode:

- ChatGPT/Codex authenticates to the MCP server with an MCP-specific OAuth access token;
- the MCP access token is not a Google token and is never forwarded to Google;
- each connected Google account is identified by its Google subject and email address;
- its Google refresh token is encrypted before being persisted on the operator's infrastructure;
- short-lived Google access tokens are created server-side only when Google Play APIs are called;
- Google Play API results are returned to the authenticated MCP client.

The remote state file does not persist MCP access tokens or MCP refresh tokens. Those are signed by the server. Short-lived authorization transactions and authorization codes are kept only in memory.

Operators are responsible for their own infrastructure, including access controls, TLS termination, backups, logs, retention, monitoring, and any privacy-policy obligations that apply to their deployment. A public or multi-user deployment should provide its own operator-specific privacy policy rather than relying solely on this project document.
