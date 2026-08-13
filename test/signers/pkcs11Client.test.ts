import type { SoftHsmCfg } from "src/signers/pkcs11Client.js";
import type { Hex } from "src/signers/types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockMod,
  mockSession,
  mockSlot,
  mockSlots,
  mockPublicKey,
  mockPrivateKey,
  mockSign,
  mockGraphene,
} = vi.hoisted(() => {
  const mockSign = {
    once: vi.fn(() => Buffer.alloc(64, 7)),
  };
  const mockPublicKey = {
    get: vi.fn(() => Buffer.from([0x04, ...Buffer.alloc(64, 1)])),
    toType: vi.fn(),
  };
  const mockPrivateKey = {
    get: vi.fn(),
    toType: vi.fn(() => ({})),
  };
  const mockSession = {
    login: vi.fn(),
    logout: vi.fn(),
    close: vi.fn(),
    find: vi.fn(),
    createSign: vi.fn(() => mockSign),
  };
  const mockSlot = {
    open: vi.fn(() => mockSession),
  };
  const mockSlots = {
    length: 1,
    items: vi.fn(() => mockSlot),
  };
  const mockMod = {
    initialize: vi.fn(),
    finalize: vi.fn(),
    getSlots: vi.fn(() => mockSlots),
  };
  const mockGraphene = {
    Module: {
      load: vi.fn(() => mockMod),
    },
    SessionFlag: {
      SERIAL_SESSION: 1,
      RW_SESSION: 2,
    },
    ObjectClass: {
      PUBLIC_KEY: 2,
      PRIVATE_KEY: 3,
    },
  };
  return {
    mockMod,
    mockSession,
    mockSlot,
    mockSlots,
    mockPublicKey,
    mockPrivateKey,
    mockSign,
    mockGraphene,
  };
});

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  return {
    ...actual,
    createRequire: (url: string | URL) => {
      const req = actual.createRequire(url);
      return Object.assign((id: string) => {
        if (id === "graphene-pk11") return mockGraphene;
        return req(id);
      }, req);
    },
  };
});

const { createGraphenePkcs11Client, createSessionLock } = await import(
  "src/signers/pkcs11Client.js"
);

const cfg: SoftHsmCfg = {
  modulePath: "/fake/libsofthsm2.so",
  pin: "1234",
  slot: 0,
  keyLabel: "custody-eth",
};

function withKeys(publicObjects = [mockPublicKey], privateObjects = [mockPrivateKey]) {
  mockSession.find.mockImplementation((query: { class: number }) => {
    const list =
      query.class === mockGraphene.ObjectClass.PUBLIC_KEY ? publicObjects : privateObjects;
    return {
      length: list.length,
      items: (i: number) => list[i],
    };
  });
}

describe("createGraphenePkcs11Client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSlots.length = 1;
    mockSlots.items.mockReturnValue(mockSlot);
    mockSlot.open.mockReturnValue(mockSession);
    mockSign.once.mockReturnValue(Buffer.alloc(64, 7));
    mockPublicKey.get.mockReturnValue(Buffer.from([0x04, ...Buffer.alloc(64, 1)]));
    withKeys();
  });

  it("requires module path and key label", () => {
    expect(() => createGraphenePkcs11Client({ ...cfg, modulePath: "" })).toThrow(
      /SOFTHSM_MODULE_PATH/,
    );
    expect(() => createGraphenePkcs11Client({ ...cfg, keyLabel: "" })).toThrow(/SOFTHSM_KEY_LABEL/);
  });

  it("rejects empty slots and out-of-range slot index", () => {
    mockSlots.length = 0;
    expect(() => createGraphenePkcs11Client(cfg)).toThrow(/No SoftHSM slots/);

    mockSlots.length = 1;
    expect(() => createGraphenePkcs11Client({ ...cfg, slot: -1 })).toThrow(/out of range/);
    expect(() => createGraphenePkcs11Client({ ...cfg, slot: 1 })).toThrow(/out of range/);
  });

  it("loads SoftHSM, reads a raw EC point, signs, and closes", async () => {
    const client = createGraphenePkcs11Client(cfg);
    expect(mockGraphene.Module.load).toHaveBeenCalledWith(cfg.modulePath, "SoftHSM");
    expect(mockMod.initialize).toHaveBeenCalled();
    expect(mockSession.login).toHaveBeenCalledWith(cfg.pin);

    const point = await client.getPublicKeyPoint();
    expect(point).toMatch(/^0x04/);
    expect(point.length).toBe(2 + 65 * 2);

    const digest = `0x${"ab".repeat(32)}` as Hex;
    const sig = await client.signEcdsa(digest);
    expect(sig).toMatch(/^0x/);
    expect(hexByteLength(sig)).toBe(64);

    client.close?.();
    expect(mockSession.logout).toHaveBeenCalled();
    expect(mockSession.close).toHaveBeenCalled();
    expect(mockMod.finalize).toHaveBeenCalled();
  });

  it("unwraps ASN.1 OCTET STRING EC points", async () => {
    const inner = Buffer.from([0x04, ...Buffer.alloc(64, 2)]);
    mockPublicKey.get.mockReturnValue(Buffer.from([0x04, inner.length, ...inner]));
    const client = createGraphenePkcs11Client(cfg);
    const point = await client.getPublicKeyPoint();
    expect(hexByteLength(point)).toBe(65);
    expect(point.startsWith("0x04")).toBe(true);
  });

  it("rejects unrecognised EC point encodings", async () => {
    mockPublicKey.get.mockReturnValue(Buffer.from([0x02, 0x01]));
    const client = createGraphenePkcs11Client(cfg);
    await expect(client.getPublicKeyPoint()).rejects.toThrow(/Unrecognised CKA_EC_POINT/);
  });

  it("uses an explicit key label when provided", async () => {
    const client = createGraphenePkcs11Client(cfg);
    await client.getPublicKeyPoint("other-label");
    expect(mockSession.find).toHaveBeenCalledWith({
      class: mockGraphene.ObjectClass.PUBLIC_KEY,
      label: "other-label",
    });
    await client.signEcdsa(`0x${"cd".repeat(32)}` as Hex, "other-label");
    expect(mockSession.find).toHaveBeenCalledWith({
      class: mockGraphene.ObjectClass.PRIVATE_KEY,
      label: "other-label",
    });
  });

  it("rejects digests that are not 32 bytes", async () => {
    const client = createGraphenePkcs11Client(cfg);
    await expect(client.signEcdsa("0xabcd" as Hex)).rejects.toThrow(/32 bytes/);
  });

  it("rejects unexpected ECDSA signature lengths", async () => {
    mockSign.once.mockReturnValue(Buffer.alloc(70, 1));
    const client = createGraphenePkcs11Client(cfg);
    await expect(client.signEcdsa(`0x${"11".repeat(32)}` as Hex)).rejects.toThrow(
      /Unexpected ECDSA signature length/,
    );
  });

  it("throws when the key label is missing from the token", async () => {
    withKeys([], []);
    const client = createGraphenePkcs11Client(cfg);
    await expect(client.getPublicKeyPoint()).rejects.toThrow(/SoftHSM key not found/);
  });

  it("still finalizes when logout throws", () => {
    mockSession.logout.mockImplementation(() => {
      throw new Error("logout failed");
    });
    const client = createGraphenePkcs11Client(cfg);
    expect(() => client.close?.()).toThrow(/logout failed/);
    expect(mockSession.close).toHaveBeenCalled();
    expect(mockMod.finalize).toHaveBeenCalled();
  });

  it("serializes concurrent session operations", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    mockPublicKey.get.mockImplementation(() => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      inFlight--;
      return Buffer.from([0x04, ...Buffer.alloc(64, 1)]);
    });
    mockSign.once.mockImplementation(() => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      inFlight--;
      return Buffer.alloc(64, 7);
    });

    const client = createGraphenePkcs11Client(cfg);
    const digest = `0x${"ab".repeat(32)}` as Hex;
    await Promise.all([
      client.getPublicKeyPoint(),
      client.signEcdsa(digest),
      client.getPublicKeyPoint(),
      client.signEcdsa(digest),
    ]);
    expect(maxInFlight).toBe(1);
  });

  it("keeps the session lock queue moving after a failed op", async () => {
    withKeys([], []);
    const client = createGraphenePkcs11Client(cfg);
    await expect(client.getPublicKeyPoint()).rejects.toThrow(/SoftHSM key not found/);

    withKeys();
    const point = await client.getPublicKeyPoint();
    expect(point).toMatch(/^0x04/);
  });
});

describe("createSessionLock", () => {
  it("runs tasks strictly one at a time", async () => {
    const withLock = createSessionLock();
    const order: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    async function task(id: number, ms: number) {
      return withLock(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, ms));
        order.push(id);
        inFlight--;
      });
    }

    await Promise.all([task(1, 30), task(2, 5), task(3, 5)]);
    expect(maxInFlight).toBe(1);
    expect(order).toEqual([1, 2, 3]);
  });
});

function hexByteLength(hex: Hex): number {
  return (hex.length - 2) / 2;
}
