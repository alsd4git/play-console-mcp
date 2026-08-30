#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mainHelp, runAuthCommand } from "./cli.js";

async function startServer(): Promise<void> {
  const [{ client, reportingClient, config }, { createServer }] = await Promise.all([
    import("./config.js"),
    import("./server.js"),
  ]);
  const server = createServer(client, reportingClient, config.packageName, config.allowDestructive, {
    profile: config.profile,
    allowedPackages: config.allowedPackages,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "auth") {
    await runAuthCommand(args.slice(1));
    return;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    console.log(mainHelp());
    return;
  }
  if (command && command !== "serve" && command !== "--stdio") {
    throw new Error(`Unknown command '${command}'.\n\n${mainHelp()}`);
  }
  await startServer();
}

main().catch((error) => {
  console.error(`play-console-mcp: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
