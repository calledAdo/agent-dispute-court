/** Whole-cent decimal such as "0.04". Anything else is refused. */
export function isValidPrice(p: unknown): p is string {
  return typeof p === "string" && /^\d{1,6}\.\d{2}$/.test(p) && Number(p) > 0;
}
