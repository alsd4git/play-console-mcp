import { createTokenProvider as createServiceAccountTokenProvider } from "./play/auth.js";
import { createOAuthTokenProvider, defaultOAuthTokenPath } from "./play/oauth.js";
import { GooglePlayClient, REPORTING_BASE_URL } from "./play/client.js";
import { parseToolProfile } from "./tool-policy.js";

export type GoogleAuthMode = "auto" | "oauth" | "service-account";

type TokenProvider = () => Promise<string>;

function envBoolean(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function parseAuthMode(value: string | undefined): GoogleAuthMode {
  if (!value || value === "auto") return "auto";
  if (value === "oauth" || value === "service-account") return value;
  throw new Error(
    `Invalid GOOGLE_PLAY_AUTH_MODE '${value}'. Expected 'auto', 'oauth', or 'service-account'.`,
  );
}

function serviceAccountConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY?.trim() ||
      process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH?.trim(),
  );
}

function configuredTokenProvider(mode: GoogleAuthMode): {
  provider: TokenProvider;
  resolvedMode: Exclude<GoogleAuthMode, "auto">;
} {
  const resolvedMode =
    mode === "auto" ? (serviceAccountConfigured() ? "service-account" : "oauth") : mode;
  if (resolvedMode === "service-account") {
    return {
      provider: createServiceAccountTokenProvider({
        serviceAccountKey: process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
        serviceAccountKeyPath: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH,
      }),
      resolvedMode,
    };
  }
  return {
    provider: createOAuthTokenProvider({ tokenPath: defaultOAuthTokenPath() }),
    resolvedMode,
  };
}

function allowedPackages(): ReadonlySet<string> | undefined {
  const raw = process.env.GOOGLE_PLAY_ALLOWED_PACKAGES;
  if (!raw) return undefined;
  const packages = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return packages.length > 0 ? new Set(packages) : undefined;
}

const requestedAuthMode = parseAuthMode(process.env.GOOGLE_PLAY_AUTH_MODE);
const auth = configuredTokenProvider(requestedAuthMode);

export const config = {
  packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME?.trim() || undefined,
  allowDestructive: envBoolean("GOOGLE_PLAY_ALLOW_DESTRUCTIVE"),
  profile: parseToolProfile(
    process.env.GOOGLE_PLAY_PROFILE?.trim().toLowerCase(),
    envBoolean("GOOGLE_PLAY_READ_ONLY"),
  ),
  allowedPackages: allowedPackages(),
  authMode: auth.resolvedMode,
  oauthTokenPath: defaultOAuthTokenPath(),
};

export const client = new GooglePlayClient(auth.provider);
export const reportingClient = new GooglePlayClient(auth.provider, REPORTING_BASE_URL);
