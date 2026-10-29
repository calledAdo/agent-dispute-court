/** `GOOG, msft` to ["GOOG","MSFT"]: symbols with no independent price feed. */
export function parseUnavailable(text: string | undefined): string[] {
  return (text ?? "").split(",").map((s) => s.trim().toUpperCase()).filter((s) => s !== "");
}
