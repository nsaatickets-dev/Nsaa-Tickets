import { describe, it, expect } from "vitest";
import {
  isMoolreAccepted,
  parseExternalRef,
  detectMoolreTransferChannel,
  transferChannelsToTry,
  ALL_MOOLRE_TRANSFER_CHANNELS,
} from "./client";

describe("isMoolreAccepted", () => {
  it("accepts the number 1", () => {
    expect(isMoolreAccepted(1)).toBe(true);
  });

  it("accepts the string \"1\" - the actual shape Moolre's docs show for a successful transfer", () => {
    // Regression test: a previous bug compared this with strict `=== 1`,
    // which silently misclassified every real acceptance as a rejection
    // because Moolre's PHP backend returns this as a string on success.
    expect(isMoolreAccepted("1")).toBe(true);
  });

  it("accepts \"1\" with surrounding whitespace", () => {
    expect(isMoolreAccepted(" 1 ")).toBe(true);
  });

  it("rejects 0, \"0\", undefined, null, and other statuses", () => {
    expect(isMoolreAccepted(0)).toBe(false);
    expect(isMoolreAccepted("0")).toBe(false);
    expect(isMoolreAccepted(undefined)).toBe(false);
    expect(isMoolreAccepted(null)).toBe(false);
    expect(isMoolreAccepted(2)).toBe(false);
    expect(isMoolreAccepted("")).toBe(false);
  });
});

describe("parseExternalRef", () => {
  it("parses the payout format (payout:<id>:<channel>)", () => {
    expect(parseExternalRef("payout:abc123:6")).toEqual({ kind: "payout", id: "abc123" });
  });

  it("parses the refund format (refund:<orderId>:<ts>:<channel>) - extra segments are ignored", () => {
    expect(parseExternalRef("refund:order1:1700000000000:7")).toEqual({
      kind: "refund",
      id: "order1",
    });
  });

  it("parses the order format (order:<id>:<method>:<ts>)", () => {
    expect(parseExternalRef("order:xyz:momo:1700000000000")).toEqual({ kind: "order", id: "xyz" });
  });

  it("parses the fee format (fee:<id>) with no extra segments", () => {
    expect(parseExternalRef("fee:transfer1")).toEqual({ kind: "fee", id: "transfer1" });
  });

  it("returns null for a missing id", () => {
    expect(parseExternalRef("payout:")).toBeNull();
    expect(parseExternalRef("payout")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseExternalRef("")).toBeNull();
  });
});

describe("detectMoolreTransferChannel", () => {
  it("detects MTN prefixes", () => {
    for (const prefix of ["024", "025", "053", "054", "055", "059"]) {
      expect(detectMoolreTransferChannel(`${prefix}1234567`)).toBe("1");
    }
  });

  it("detects Telecel prefixes", () => {
    for (const prefix of ["020", "050"]) {
      expect(detectMoolreTransferChannel(`${prefix}1234567`)).toBe("6");
    }
  });

  it("detects AirtelTigo prefixes", () => {
    for (const prefix of ["026", "027", "056", "057"]) {
      expect(detectMoolreTransferChannel(`${prefix}1234567`)).toBe("7");
    }
  });

  it("normalizes 233-prefixed and +233-prefixed numbers before detecting", () => {
    expect(detectMoolreTransferChannel("233241234567")).toBe("1");
    expect(detectMoolreTransferChannel("+233241234567")).toBe("1");
  });

  it("strips spaces, dashes, and parentheses before detecting", () => {
    expect(detectMoolreTransferChannel("024 123-4567")).toBe("1");
    expect(detectMoolreTransferChannel("(024) 1234567")).toBe("1");
  });

  it("returns undefined (never throws) for an unrecognized prefix", () => {
    // 030 and 028 were previously (incorrectly) classified as Telecel/AT
    // respectively - both should now be unrecognized rather than guessed
    // wrong, and this must never block a payout attempt (see
    // transferChannelsToTry below).
    expect(detectMoolreTransferChannel("0301234567")).toBeUndefined();
    expect(detectMoolreTransferChannel("0281234567")).toBeUndefined();
    expect(detectMoolreTransferChannel("not a phone number")).toBeUndefined();
  });
});

describe("transferChannelsToTry", () => {
  it("puts the guessed channel first, followed by the other two", () => {
    const channels = transferChannelsToTry("0241234567"); // MTN
    expect(channels[0]).toBe("1");
    expect(new Set(channels)).toEqual(new Set(ALL_MOOLRE_TRANSFER_CHANNELS));
    expect(channels).toHaveLength(3);
  });

  it("still returns all three channels when the prefix is unrecognized", () => {
    // This is the fix for a real bug: an unrecognized prefix used to
    // throw before any transfer was attempted at all.
    const channels = transferChannelsToTry("0301234567");
    expect(new Set(channels)).toEqual(new Set(ALL_MOOLRE_TRANSFER_CHANNELS));
    expect(channels).toHaveLength(3);
  });

  it("never returns duplicate channels", () => {
    for (const phone of ["0241234567", "0201234567", "0261234567", "0301234567"]) {
      const channels = transferChannelsToTry(phone);
      expect(new Set(channels).size).toBe(channels.length);
    }
  });
});
