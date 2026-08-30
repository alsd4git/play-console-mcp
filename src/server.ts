import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GooglePlayClient } from "./play/client.js";
import { registerReviewTools } from "./tools/reviews.js";
import { registerReleaseTools } from "./tools/releases.js";
import { registerListingTools } from "./tools/listings.js";
import { registerArtifactTools } from "./tools/artifacts.js";
import { registerRecoveryTools } from "./tools/recovery.js";
import { registerVitalsTools } from "./tools/vitals.js";
import { registerAppsTools } from "./tools/apps.js";
import { applyToolPolicy, type ToolProfile } from "./tool-policy.js";

export interface ServerPolicyOptions {
  profile?: ToolProfile;
  allowedPackages?: ReadonlySet<string>;
}

function serverInstructions(profile: ToolProfile): string {
  if (profile === "readonly") {
    return [
      "This Google Play Console MCP server is running in readonly mode.",
      "Only explicitly reviewed non-mutating tools are exposed; do not claim that a write was performed.",
      "Some Play Developer API reads open and delete an uncommitted temporary edit because Google requires an edit ID. They never commit it.",
    ].join(" ");
  }
  return [
    "This Google Play Console MCP server can expose write operations.",
    "Read the current state first, use validate_only where supported, and obtain explicit user confirmation before public replies, releases, rollout changes, listing changes, or recovery actions.",
  ].join(" ");
}

export function createServer(
  client: GooglePlayClient,
  reportingClient: GooglePlayClient,
  packageName?: string,
  allowDestructive = false,
  policy: ServerPolicyOptions = {},
): McpServer {
  const profile = policy.profile ?? "full";
  const server = new McpServer(
    { name: "play-console-mcp", version: "0.3.0" },
    { instructions: serverInstructions(profile) },
  );
  applyToolPolicy(server, {
    profile,
    defaultPackageName: packageName,
    allowedPackages: policy.allowedPackages,
  });

  registerReviewTools(server, client, packageName);
  registerReleaseTools(server, client, packageName);
  registerListingTools(server, client, packageName, allowDestructive);
  registerArtifactTools(server, client, packageName);
  registerRecoveryTools(server, client, packageName, allowDestructive);
  registerVitalsTools(server, reportingClient, packageName);
  registerAppsTools(server, reportingClient, packageName);
  return server;
}
