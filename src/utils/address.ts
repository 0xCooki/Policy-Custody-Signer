import type { Address } from "src/signers/types.js";
import { padHex, toHex } from "viem";

export function addressFromNumber(n: number | bigint): Address {
  return padHex(toHex(n), { size: 20 });
}
