import { ApiErrorCode } from "src/domain/types.js";
import { addressFromNumber } from "src/utils/address.js";
import { AppError } from "src/utils/errors.js";
import { intentToJson } from "src/utils/json.js";
import { arrayFromCsv, extractApiKey } from "src/utils/string.js";
import { describe, expect, it } from "vitest";

describe("arrayFromCsv", () => {
  it("trims entries and drops empties", () => {
    expect(arrayFromCsv(" a, ,b ,")).toEqual(["a", "b"]);
    expect(arrayFromCsv("")).toEqual([]);
  });
});

describe("extractApiKey", () => {
  it("prefers x-api-key over Bearer", () => {
    expect(extractApiKey("Bearer from-auth", "from-header")).toBe("from-header");
  });

  it("reads a Bearer token and ignores other schemes", () => {
    expect(extractApiKey("Bearer secret", undefined)).toBe("secret");
    expect(extractApiKey("Basic secret", undefined)).toBeUndefined();
    expect(extractApiKey(undefined, undefined)).toBeUndefined();
  });
});

describe("AppError", () => {
  it("defaults the message to the code", () => {
    const err = new AppError(ApiErrorCode.NotFound);
    expect(err.message).toBe(ApiErrorCode.NotFound);
    expect(err.code).toBe(ApiErrorCode.NotFound);
  });
});

describe("intentToJson", () => {
  it("stringifies value", () => {
    expect(intentToJson({ id: "1", value: 10n })).toEqual({ id: "1", value: "10" });
  });
});

describe("addressFromNumber", () => {
  it("pads to a 20-byte address", () => {
    expect(addressFromNumber(1)).toBe("0x0000000000000000000000000000000000000001");
    expect(addressFromNumber(1).length).toBe(42);
  });
});
