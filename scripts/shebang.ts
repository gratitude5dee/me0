// prepend a node shebang to a built entrypoint (bun build strips/never emits one for node targets)
import { readFileSync, writeFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: bun scripts/shebang.ts <file>");
  process.exit(1);
}
const src = readFileSync(file, "utf-8");
const body = src.startsWith("#!") ? src.slice(src.indexOf("\n") + 1) : src;
writeFileSync(file, `#!/usr/bin/env node\n${body}`);
