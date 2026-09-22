#!/usr/bin/env node
/**
 * CLI stub. Full run|inspect|stop|resume arrives with durable controller tickets.
 */
const args = process.argv.slice(2);
if (args[0] === "version" || args[0] === "--version" || args[0] === "-V") {
  console.log("graphloom 0.0.0 (TypeScript scaffold)");
  process.exit(0);
}

console.error(
  "graphloom: TypeScript runtime not yet implemented. See docs/design-typescript-core.md",
);
process.exit(1);
