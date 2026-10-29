import { execFile } from "node:child_process";

// Thin typed wrapper around `npx metal-agent`. Never builds a shell string.
// Flags follow tasks/metal-agent-help.txt. Every chain command needs --network testnet.

export type CliStatus = "paid" | "refused" | "pending" | "held" | "error";
export interface CliResult { status: CliStatus; exitCode: number; fields: Record<string, string>; stdout: string; stderr: string }
export interface RawRun { exitCode: number; stdout: string; stderr: string }
/** Runs a program with an args array. Resolves (never rejects) on a non-zero exit. */
export type Runner = (file: string, args: string[], env: Record<string, string>) => Promise<RawRun>;

/** 0 paid, 1 refused, 3 pending (rerun the same command), 4 held. Other codes (and exit 1 on an error) are reported as "error" or "refused" per the help text. */
export function statusOfExit(code: number): CliStatus {
  switch (code) {
    case 0: return "paid";
    case 1: return "refused";
    case 3: return "pending";
    case 4: return "held";
    default: return "error";
  }
}

/** Each line is `key value`; the key is the first token, the value is the rest. Lines without a value give "". */
export function parseKeyValueLines(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const i = line.search(/\s/);
    if (i === -1) out[line] = "";
    else out[line.slice(0, i)] = line.slice(i).trim();
  }
  return out;
}

export const nodeRunner: Runner = (file, args, env) =>
  new Promise((resolve) => {
    execFile(file, args, { env: { ...process.env, ...env }, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 127) : 0;
      resolve({ exitCode: code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });

const NETWORK = "testnet";

export interface CliOptions {
  run?: Runner;
  /** Only METAL_RPC_URL is passed through explicitly; its value is never logged. */
  rpcUrl?: string;
}

export function createMetalCli(o: CliOptions = {}) {
  const run = o.run ?? nodeRunner;
  const env: Record<string, string> = {};
  const rpc = o.rpcUrl ?? process.env.METAL_RPC_URL;
  if (rpc) env.METAL_RPC_URL = rpc;

  async function exec(args: string[]): Promise<CliResult> {
    const r = await run("npx", ["metal-agent", ...args], env);
    return { status: statusOfExit(r.exitCode), exitCode: r.exitCode, fields: parseKeyValueLines(r.stdout), stdout: r.stdout, stderr: r.stderr };
  }

  return {
    credentialCreate: (a: { principal: string; cap: string; budget: string; out: string; key: string; payees?: string[] }) =>
      exec(["mandate", "credential", "create", "--principal", a.principal, "--cap", a.cap, "--budget", a.budget, "--out", a.out,
        "--key", a.key, "--network", NETWORK, ...(a.payees ?? []).flatMap((p) => ["--payee", p])]),
    bind: (a: { credential: string; key: string; issuers?: string[] }) =>
      exec(["mandate", "bind", "--credential", a.credential, "--key", a.key, "--network", NETWORK, ...(a.issuers ?? []).flatMap((i) => ["--issuer", i])]),
    replace: (a: { credential: string; replaces: string; key: string }) =>
      exec(["mandate", "replace", "--credential", a.credential, "--replaces", a.replaces, "--key", a.key, "--network", NETWORK]),
    pull: (a: { credential: string; to: string; amount: string; paymentId: string }) =>
      exec(["mandate", "pull", "--credential", a.credential, "--to", a.to, "--amount", a.amount, "--network", NETWORK, "--payment-id", a.paymentId]),
    verify: (a: { credential: string; issuer: string; tx?: string }) =>
      exec(["mandate", "verify", "--credential", a.credential, "--issuer", a.issuer, "--network", NETWORK, ...(a.tx ? ["--tx", a.tx] : [])]),
    pay: (url: string, credential: string) => exec(["pay", url, "--mandate", credential, "--network", NETWORK]),
  };
}
