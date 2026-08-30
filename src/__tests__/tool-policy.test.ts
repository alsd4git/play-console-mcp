import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { applyToolPolicy, parseToolProfile, toolAnnotations } from "../tool-policy.js";

interface Registration {
  name: string;
  rest: unknown[];
  disabled: boolean;
}

function fakeServer() {
  const registrations: Registration[] = [];
  const server = {
    tool(name: string, ...rest: unknown[]) {
      const registration: Registration = { name, rest, disabled: false };
      registrations.push(registration);
      return {
        disable() {
          registration.disabled = true;
        },
      };
    },
  } as unknown as McpServer;
  return { server, registrations };
}

function register(
  server: McpServer,
  name: string,
  callback: (args: { package_name?: string }) => unknown = vi.fn(),
) {
  const loose = server as unknown as {
    tool: (name: string, ...rest: unknown[]) => unknown;
  };
  loose.tool(name, "description", { package_name: z.string().optional() }, callback);
}

describe("tool policy", () => {
  it("parses full and readonly profiles", () => {
    expect(parseToolProfile(undefined)).toBe("full");
    expect(parseToolProfile("read-only")).toBe("readonly");
    expect(parseToolProfile("full", true)).toBe("readonly");
    expect(() => parseToolProfile("unsafe")).toThrow("Invalid GOOGLE_PLAY_PROFILE");
  });

  it("annotates known reads and writes conservatively", () => {
    expect(toolAnnotations("list_reviews")).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(toolAnnotations("reply_to_review")).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
    });
  });

  it("exposes only allowlisted tools in readonly mode", () => {
    const { server, registrations } = fakeServer();
    applyToolPolicy(server, { profile: "readonly" });

    register(server, "list_reviews");
    register(server, "reply_to_review");
    register(server, "new_upstream_tool");

    expect(registrations.map(({ name, disabled }) => ({ name, disabled }))).toEqual([
      { name: "list_reviews", disabled: false },
      { name: "reply_to_review", disabled: true },
      { name: "new_upstream_tool", disabled: true },
    ]);
    expect(registrations[0].rest.at(-2)).toMatchObject({ readOnlyHint: true });
  });

  it("preserves full mode while adding annotations", () => {
    const { server, registrations } = fakeServer();
    applyToolPolicy(server, { profile: "full" });
    register(server, "reply_to_review");

    expect(registrations[0].disabled).toBe(false);
    expect(registrations[0].rest.at(-2)).toMatchObject({ readOnlyHint: false });
  });

  it("enforces an optional package allowlist before calling a tool", async () => {
    const callback = vi.fn().mockResolvedValue({ ok: true });
    const { server, registrations } = fakeServer();
    applyToolPolicy(server, {
      profile: "readonly",
      allowedPackages: new Set(["com.example.allowed"]),
    });
    register(server, "get_listing", callback);

    const wrapped = registrations[0].rest.at(-1) as (
      args: { package_name?: string },
    ) => Promise<unknown>;
    await expect(wrapped({ package_name: "com.example.blocked" })).rejects.toThrow(
      "is not allowed",
    );
    await expect(wrapped({ package_name: "com.example.allowed" })).resolves.toEqual({
      ok: true,
    });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("hides list_apps when a package allowlist is configured", () => {
    const { server, registrations } = fakeServer();
    applyToolPolicy(server, {
      profile: "full",
      allowedPackages: new Set(["com.example.allowed"]),
    });
    register(server, "list_apps");
    expect(registrations[0].disabled).toBe(true);
  });
});
