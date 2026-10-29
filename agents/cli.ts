import { execFile } from "node:child_process";

// Thin typed wrapper around `npx metal-agent`. Never builds a shell string.
// Flags follow tasks/metal-agent-help.txt. Every chain command needs --network testnet.

export type CliStatus = "paid" | "refused" | "pending" | "held" | "error";
export interface CliResult { status: CliStatus; refusalCode?: string; error?: string; exitCode: number; fields: Record<string, string>; stdout: string; stderr: string }
export interface RawRun { exitCode: number; stdout: string; stderr: string }
/** Runs a program with an args array. Resolves (never rejects) on a non-zero exit. */
export type Runner = (file: string, args: string[], env: Record<string, string>) => Promise<RawRun>;

/**
 * 0 paid, 3 pending, 4 held. Exit 1 is "refused" ONLY when the output says so (see isRefusal); otherwise it
 * is a crash or tool error and reports "error", so a failure never looks like a mandate refusal.
 */
export function statusOfExit(code: number, refusal = false): CliStatus {
  switch (code) {
    case 0: return "paid";
    case 1: return refusal ? "refused" : "error";
    case 3: return "pending";
    case 4: return "held";
    default: return "error";
  }
}

/** Strips URLs and 32+ hex tokens, like court/api.ts sanitizeError. */
export function redact(s: string): string {
  return s.replace(/https?:\/\/\S+/g, "[url]").replace(/(?:0x)?[0-9a-fA-F]{32,}/g, "[hex]");
}

/** The last few lines of stderr (or stdout when stderr is empty), redacted. */
export function tail(stderr: string, stdout = "", lines = 5): string {
  const text = (stderr.trim() || stdout.trim()).split("\n").slice(-lines).join("\n");
  return redact(text);
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

/** The code in an `error: payment refused: <code> (...)` line, e.g. mandate_cap_exceeded. Looked for in stdout and stderr. */
export function parseRefusalCode(text: string): string | undefined {
  return /error: payment refused: ([A-Za-z0-9_]+)/.exec(text)?.[1];
}

const USDZ_UNIT = 10n ** 18n;

/** Decimal *USDZ ("0.04", "10") to base units. Throws on anything else; no floating point. */
export function parseUsdz(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,18}))?$/.exec(s.trim());
  if (!m) throw new Error(`not a USDZ amount: ${s}`);
  return BigInt(m[1]) * USDZ_UNIT + BigInt((m[2] ?? "").padEnd(18, "0"));
}

/** Base units to a decimal *USDZ string to the cent (rounded down), as the CLI wants amounts. */
export function formatUsdz(x: bigint): string {
  const cents = x / (USDZ_UNIT / 100n);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

export interface MandateStatus { spent: bigint; budget: bigint; payments: number }

/** Reads `spent 0.04 *USDZ of 10 *USDZ` and `payments 2` from `mandate status` output. */
export function parseStatus(stdout: string, stderr = ""): MandateStatus {
  const sp = /^\s*spent\s+([\d.]+)\s*\*USDZ\s+of\s+([\d.]+)\s*\*USDZ/m.exec(stdout);
  if (!sp) throw new Error(`mandate status: no spent line: ${tail(stderr, stdout)}`);
  const pay = /^\s*payments\s+(\d+)/m.exec(stdout);
  return { spent: parseUsdz(sp[1]), budget: parseUsdz(sp[2]), payments: pay ? Number(pay[1]) : 0 };
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
    // --no-install: a missing package fails fast instead of reaching the network.
    const r = await run("npx", ["--no-install", "metal-agent", ...args], env);
    const fields = parseKeyValueLines(r.stdout);
    const refusalCode = parseRefusalCode(r.stdout + "\n" + r.stderr);
    // UNVERIFIED: the documented refusal outcome line for `mandate pull` is assumed to be `status refused`.
    const refusal = refusalCode !== undefined || fields.status === "refused";
    const status = statusOfExit(r.exitCode, refusal);
    return {
      status, refusalCode, exitCode: r.exitCode, fields, stdout: r.stdout, stderr: r.stderr,
      ...(status === "error" ? { error: tail(r.stderr, r.stdout) } : {}),
    };
  }

  return {
    credentialCreate: (a: { principal: string; cap: string; budget: string; out: string; key: string; payees?: string[]; mandateKeyFile?: string }) =>
      exec(["mandate", "credential", "create", "--principal", a.principal, "--cap", a.cap, "--budget", a.budget, "--out", a.out,
        "--key", a.key, "--network", NETWORK, ...(a.payees ?? []).flatMap((p) => ["--payee", p]),
        ...(a.mandateKeyFile ? ["--mandate-key-file", a.mandateKeyFile] : [])]),
    bind: (a: { credential: string; key: string; issuers?: string[] }) =>
      exec(["mandate", "bind", "--credential", a.credential, "--key", a.key, "--network", NETWORK, ...(a.issuers ?? []).flatMap((i) => ["--issuer", i])]),
    replace: (a: { credential: string; replaces: string; key: string }) =>
      exec(["mandate", "replace", "--credential", a.credential, "--replaces", a.replaces, "--key", a.key, "--network", NETWORK]),
    pull: (a: { credential: string; to: string; amount: string; paymentId: string }) =>
      exec(["mandate", "pull", "--credential", a.credential, "--to", a.to, "--amount", a.amount, "--network", NETWORK, "--payment-id", a.paymentId]),
    /** `mandate status --credential <f> --network testnet`; throws if the output has no spent line. */
    status: async (credential: string): Promise<MandateStatus & { result: CliResult }> => {
      const result = await exec(["mandate", "status", "--credential", credential, "--network", NETWORK]);
      return { ...parseStatus(result.stdout, result.stderr), result };
    },
    verify: (a: { credential: string; issuer: string; tx?: string }) =>
      exec(["mandate", "verify", "--credential", a.credential, "--issuer", a.issuer, "--network", NETWORK, ...(a.tx ? ["--tx", a.tx] : [])]),
    pay: (url: string, credential: string) => exec(["pay", url, "--mandate", credential, "--network", NETWORK]),
  };
}
