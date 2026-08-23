#!/usr/bin/env node
/**
 * Entry point. `feedly-mcp` starts the MCP stdio server; `feedly-mcp doctor`
 * runs the connection check from spec §9.
 */

import { runDoctor } from "./doctor.js";

const USAGE = `feedly-mcp — read your own Feedly subscriptions from an MCP client

Usage:
  feedly-mcp                 Start the MCP server on stdio (what Claude runs)
  feedly-mcp doctor          Check the token, list folders, show quota
  feedly-mcp doctor -v       ...and print every resolved setting
  feedly-mcp doctor --refresh  Clear the cache first

Options:
  --config <path>   Use this config file instead of ~/.config/feedly-mcp/config.toml
  -h, --help        Show this message

The token is read from FEEDLY_TOKEN, or from the file named by feedly.token_file.
It is never printed, logged, or returned in a tool result.
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(USAGE);
    return;
  }

  const configIdx = argv.indexOf("--config");
  const configPath = configIdx >= 0 ? argv[configIdx + 1] : undefined;
  if (configIdx >= 0 && !configPath) {
    process.stderr.write("--config needs a path\n");
    process.exitCode = 2;
    return;
  }

  const command = argv.find((a) => !a.startsWith("-") && a !== configPath);

  if (command === "doctor") {
    process.exitCode = await runDoctor({
      configPath,
      refresh: argv.includes("--refresh"),
      verbose: argv.includes("-v") || argv.includes("--verbose"),
    });
    return;
  }

  if (command !== undefined) {
    process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  const { startServer } = await import("./server.js");
  await startServer({ configPath });
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
