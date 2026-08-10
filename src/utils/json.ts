export function intentToJson(intent: { value: bigint; [k: string]: unknown }) {
  return { ...intent, value: intent.value.toString() };
}

// Must always build objects with a fixed key order
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}
