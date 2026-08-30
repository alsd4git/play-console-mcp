# Privacy

This open-source MCP server has no built-in telemetry, analytics service, hosted backend, or credential collection.

When self-hosted, it processes Google Play Console data only to answer MCP tool calls. Google OAuth refresh tokens or service-account credentials remain on the machine running the MCP server and are sent only to Google's authentication endpoints. Google Play API responses are returned to the MCP client selected by the operator, such as Codex, Claude, or ChatGPT through a private tunnel.

Operators are responsible for the privacy policies, logging configuration, access controls, and retention practices of their own infrastructure and chosen MCP client.
