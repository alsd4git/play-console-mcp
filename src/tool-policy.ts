import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type ToolProfile = "full" | "readonly";

export interface ToolPolicyOptions {
  profile: ToolProfile;
  defaultPackageName?: string;
  allowedPackages?: ReadonlySet<string>;
}

interface ToolAnnotationsLike {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

interface RegisteredToolControl {
  disable(): void;
}

const ANNOTATION_KEYS = new Set([
  "title",
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
]);

/**
 * Tools which do not intentionally change Google Play state.
 *
 * This is deliberately an allowlist: in readonly mode, a newly-added upstream
 * tool is disabled until it is reviewed and classified here.
 */
export const READ_ONLY_TOOLS = new Set([
  // Reviews
  "list_reviews",
  "get_review",

  // Releases and testing
  "list_tracks",
  "get_track",
  "list_releases",
  "get_country_availability",
  "get_testers",

  // Uploaded artifacts and generated metadata
  "list_bundles",
  "list_apks",
  "list_generated_apks",
  "get_expansion_file",
  "list_device_tier_configs",
  "get_device_tier_config",

  // Store listings
  "list_listings",
  "get_listing",
  "get_app_details",
  "list_listing_images",

  // App recovery
  "list_recovery_actions",

  // Android vitals and reporting
  "list_anomalies",
  "get_vitals_freshness",
  "query_crash_rate",
  "query_anr_rate",
  "query_error_counts",
  "query_slow_start_rate",
  "query_slow_rendering_rate",
  "query_excessive_wakeup_rate",
  "query_stuck_wakelock_rate",
  "query_lmk_rate",
  "query_bitmap_memory_usage",
  "query_memory_usage",
  "search_error_issues",
  "search_error_reports",

  // App discovery and report filters
  "list_apps",
  "get_release_filter_options",
]);

const DESTRUCTIVE_TOOLS = new Set([
  "delete_listing",
  "delete_all_listings",
  "delete_listing_image",
  "delete_all_listing_images",
  "halt_rollout",
  "deploy_recovery_action",
  "add_recovery_targeting",
  "cancel_recovery_action",
]);

export function parseToolProfile(value: string | undefined, readOnlyFlag = false): ToolProfile {
  if (readOnlyFlag) return "readonly";
  if (!value || value === "full") return "full";
  if (value === "readonly" || value === "read-only" || value === "read_only") {
    return "readonly";
  }
  throw new Error(`Invalid GOOGLE_PLAY_PROFILE '${value}'. Expected 'full' or 'readonly'.`);
}

export function toolAnnotations(name: string): ToolAnnotationsLike {
  const readOnly = READ_ONLY_TOOLS.has(name);
  return {
    readOnlyHint: readOnly,
    destructiveHint: readOnly ? false : DESTRUCTIVE_TOOLS.has(name),
    idempotentHint: readOnly,
    openWorldHint: true,
  };
}

function isAnnotationObject(value: unknown): value is ToolAnnotationsLike {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (entries.length === 0) return false;
  return entries.every(
    ([key, item]) =>
      ANNOTATION_KEYS.has(key) &&
      (typeof item === "string" || typeof item === "boolean" || item === undefined),
  );
}

function callbackIndex(rest: unknown[]): number {
  for (let index = rest.length - 1; index >= 0; index -= 1) {
    if (typeof rest[index] === "function") return index;
  }
  throw new Error("MCP tool registration did not include a callback");
}

function packageFromArguments(args: unknown, defaultPackageName?: string): string | undefined {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const packageName = (args as Record<string, unknown>).package_name;
    if (typeof packageName === "string" && packageName.length > 0) return packageName;
  }
  return defaultPackageName;
}

/**
 * Applies annotations and a server-side tool policy without changing the
 * individual upstream tool modules. Disabled tools are omitted from tools/list
 * and rejected by the MCP SDK if a client tries to call them by name.
 */
export function applyToolPolicy(server: McpServer, options: ToolPolicyOptions): void {
  const mutableServer = server as unknown as {
    tool: (name: string, ...rest: unknown[]) => unknown;
  };
  const originalTool = mutableServer.tool.bind(server);

  mutableServer.tool = (name: string, ...rest: unknown[]) => {
    let index = callbackIndex(rest);
    const originalCallback = rest[index] as (...args: unknown[]) => unknown;

    if (options.allowedPackages && options.allowedPackages.size > 0) {
      rest[index] = async (...callbackArgs: unknown[]) => {
        if (name === "list_apps") {
          throw new Error(
            "list_apps is disabled when GOOGLE_PLAY_ALLOWED_PACKAGES is set because it would reveal apps outside the allowlist.",
          );
        }
        const packageName = packageFromArguments(callbackArgs[0], options.defaultPackageName);
        if (!packageName) {
          throw new Error(
            "This server requires package_name because GOOGLE_PLAY_ALLOWED_PACKAGES is set and no default package is configured.",
          );
        }
        if (!options.allowedPackages?.has(packageName)) {
          throw new Error(`Package '${packageName}' is not allowed by GOOGLE_PLAY_ALLOWED_PACKAGES.`);
        }
        return originalCallback(...callbackArgs);
      };
    }

    index = callbackIndex(rest);
    const annotations = toolAnnotations(name);
    if (isAnnotationObject(rest[index - 1])) {
      rest[index - 1] = { ...(rest[index - 1] as ToolAnnotationsLike), ...annotations };
    } else {
      rest.splice(index, 0, annotations);
    }

    const registered = originalTool(name, ...rest) as RegisteredToolControl;
    const allowedByProfile = options.profile === "full" || READ_ONLY_TOOLS.has(name);
    const allowedByPackagePolicy = !(
      options.allowedPackages &&
      options.allowedPackages.size > 0 &&
      name === "list_apps"
    );
    if (!allowedByProfile || !allowedByPackagePolicy) registered.disable();
    return registered;
  };
}
