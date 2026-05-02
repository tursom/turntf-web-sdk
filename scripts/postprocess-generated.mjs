import { readFileSync, writeFileSync } from "node:fs";

const files = [
  new URL("../src/generated/client.ts", import.meta.url),
  new URL("../src/generated/relay.ts", import.meta.url),
];

for (const generatedPath of files) {
  let source = readFileSync(generatedPath, "utf8");

  source = source
    .replace(/\n(\s*)create\(/g, "\n$1override create(")
    .replace(/\n(\s*)internalBinaryRead\(/g, "\n$1override internalBinaryRead(")
    .replace(/\n(\s*)internalBinaryWrite\(/g, "\n$1override internalBinaryWrite(")
    .replace(/message\.([A-Za-z0-9_]+)\[i\]/g, "message.$1[i]!");

  writeFileSync(generatedPath, source);
}
