export function intentToJson(intent: { value: bigint; [k: string]: unknown }) {
  return { ...intent, value: intent.value.toString() };
}
