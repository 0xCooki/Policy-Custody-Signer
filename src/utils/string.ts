export function arrayFromCsv(value: string): string[] {
  return value
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

export function extractApiKey(
  authorization: string | undefined,
  xApiKey: string | undefined,
): string | undefined {
  if (xApiKey) return xApiKey;
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  return undefined;
}
