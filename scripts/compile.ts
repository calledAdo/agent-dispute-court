import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const solc = createRequire(import.meta.url)("solc");
const dir = new URL("../contracts/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".sol"));
const sources = Object.fromEntries(files.map((f) => [f, { content: readFileSync(new URL(f, dir), "utf8") }]));

const output = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: "Solidity",
      sources,
      settings: {
        evmVersion: "cancun",
        optimizer: { enabled: true, runs: 200 },
        outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
      },
    }),
  ),
);

const errors = (output.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
for (const e of output.errors ?? []) console.error(e.formattedMessage);
if (errors.length > 0) process.exit(1);

mkdirSync(new URL("build/", dir), { recursive: true });
for (const [file, contracts] of Object.entries<Record<string, any>>(output.contracts)) {
  for (const [name, c] of Object.entries(contracts)) {
    writeFileSync(new URL(`build/${name}.json`, dir), JSON.stringify({ abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` }, null, 2) + "\n");
    console.log(`${file}:${name}`);
  }
}
