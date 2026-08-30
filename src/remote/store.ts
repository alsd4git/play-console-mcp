import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { dirname } from "node:path";

export interface RegisteredClient {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
  createdAt: string;
}

interface StoredGoogleUser {
  subject: string;
  email: string;
  encryptedRefreshToken: string;
  googleScopes: string[];
  updatedAt: string;
}

interface StoreFile {
  version: 1;
  clients: Record<string, RegisteredClient>;
  users: Record<string, StoredGoogleUser>;
}

function emptyStore(): StoreFile {
  return { version: 1, clients: {}, users: {} };
}

function validateStore(value: unknown, source: string): StoreFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} is not a valid remote OAuth store.`);
  }
  const store = value as Partial<StoreFile>;
  if (
    store.version !== 1 ||
    !store.clients ||
    typeof store.clients !== "object" ||
    !store.users ||
    typeof store.users !== "object"
  ) {
    throw new Error(`${source} is missing version, clients, or users.`);
  }
  return store as StoreFile;
}

async function readStore(path: string): Promise<StoreFile> {
  try {
    return validateStore(JSON.parse(await readFile(path, "utf8")), path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    if (error instanceof SyntaxError) {
      throw new Error(`${path} is not valid JSON: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

async function writeStore(path: string, store: StoreFile): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (platform() === "win32" && (code === "EEXIST" || code === "EPERM")) {
      await rm(path, { force: true });
      await rename(temporaryPath, path);
    } else {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
  await chmod(path, 0o600).catch(() => undefined);
}

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(`google-refresh-token\0${secret}`, "utf8").digest();
}

function encrypt(secret: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

function decrypt(secret: string, encrypted: string): string {
  const [version, ivText, tagText, ciphertextText] = encrypted.split(".");
  if (version !== "v1" || !ivText || !tagText || !ciphertextText) {
    throw new Error("Stored Google refresh token has an unsupported format.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveKey(secret),
    Buffer.from(ivText, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export class RemoteOAuthStore {
  private data?: StoreFile;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly masterSecret: string,
  ) {}

  private async load(): Promise<StoreFile> {
    this.data ??= await readStore(this.path);
    return this.data;
  }

  private async persist(): Promise<void> {
    const data = await this.load();
    this.persistChain = this.persistChain.then(() => writeStore(this.path, data));
    await this.persistChain;
  }

  async registerClient(
    input: { redirectUris: string[]; clientName?: string },
    maxClients = 100,
  ): Promise<RegisteredClient> {
    const data = await this.load();
    if (Object.keys(data.clients).length >= maxClients) {
      throw new Error(
        `OAuth client registration limit reached (${maxClients}). Reuse an existing registered client or remove stale client entries from the private state file.`,
      );
    }
    const clientId = `mcp_${randomBytes(24).toString("base64url")}`;
    const client: RegisteredClient = {
      clientId,
      redirectUris: input.redirectUris,
      ...(input.clientName ? { clientName: input.clientName } : {}),
      createdAt: new Date().toISOString(),
    };
    data.clients[clientId] = client;
    await this.persist();
    return client;
  }

  async client(clientId: string): Promise<RegisteredClient | undefined> {
    return (await this.load()).clients[clientId];
  }

  async upsertGoogleUser(input: {
    subject: string;
    email: string;
    refreshToken?: string;
    googleScopes: string[];
  }): Promise<void> {
    const data = await this.load();
    const existing = data.users[input.subject];
    if (!input.refreshToken && !existing) {
      throw new Error(
        "Google did not return a refresh token. Reconnect and approve consent again, or revoke the existing app grant in your Google account first.",
      );
    }
    const encryptedRefreshToken = input.refreshToken
      ? encrypt(this.masterSecret, input.refreshToken)
      : existing!.encryptedRefreshToken;
    data.users[input.subject] = {
      subject: input.subject,
      email: input.email,
      encryptedRefreshToken,
      googleScopes:
        input.googleScopes.length > 0 ? input.googleScopes : (existing?.googleScopes ?? []),
      updatedAt: new Date().toISOString(),
    };
    await this.persist();
  }

  async googleRefreshToken(subject: string): Promise<string> {
    const user = (await this.load()).users[subject];
    if (!user) throw new Error("Google account is no longer connected to this MCP server.");
    return decrypt(this.masterSecret, user.encryptedRefreshToken);
  }

  async updateGoogleRefreshToken(subject: string, refreshToken: string): Promise<void> {
    const data = await this.load();
    const user = data.users[subject];
    if (!user) throw new Error("Google account is no longer connected to this MCP server.");
    user.encryptedRefreshToken = encrypt(this.masterSecret, refreshToken);
    user.updatedAt = new Date().toISOString();
    await this.persist();
  }
}
