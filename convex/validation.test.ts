import { describe, it, expect } from "vitest";
import { requireMtnGhanaPhone } from "./validation";

describe("requireMtnGhanaPhone", () => {
  it("accepts an MTN number and normalizes it to local format", () => {
    expect(requireMtnGhanaPhone("024 436 3737")).toBe("0244363737");
    expect(requireMtnGhanaPhone("+233244363737")).toBe("0244363737");
  });

  it("rejects an AirtelTigo number - the exact case that surfaced this feature", () => {
    // 027 is AirtelTigo, not MTN - Moolre confirmed only MTN transfers
    // reliably right now (see moolre/client.ts's transferChannelsToTry).
    expect(() => requireMtnGhanaPhone("0274363737")).toThrow(/MTN/);
  });

  it("rejects a Telecel number", () => {
    expect(() => requireMtnGhanaPhone("0201234567")).toThrow(/MTN/);
  });

  it("rejects a malformed number before even checking the network", () => {
    expect(() => requireMtnGhanaPhone("not a phone number")).toThrow(/Ghanaian phone number/);
  });
});
