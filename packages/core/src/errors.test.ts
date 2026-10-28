import { describe, expect, it } from "vitest";
import { errorMessage } from "./index";

describe("errorMessage", () => {
  it("returns an Error's message", () => {
    expect(errorMessage(new TypeError("bad input"))).toBe("bad input");
  });

  it("names an Error that has no message", () => {
    expect(errorMessage(new RangeError())).toBe("RangeError");
  });

  it("returns a thrown string as it is", () => {
    expect(errorMessage("engine not found")).toBe("engine not found");
  });

  // A rejection from a platform API or a library can be a plain object.
  it("uses a plain object's message", () => {
    expect(errorMessage({ status: 500, message: "upstream failed" })).toBe("upstream failed");
  });

  it("serialises a plain object without a message instead of [object Object]", () => {
    expect(errorMessage({ code: "EPERM", path: "/vault" })).toBe('{"code":"EPERM","path":"/vault"}');
  });

  it("falls back to String for values JSON cannot serialise", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(errorMessage(cyclic)).toBe("[object Object]");
    expect(errorMessage(10n)).toBe("10");
  });

  it("stringifies primitives", () => {
    expect(errorMessage(undefined)).toBe("undefined");
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(42)).toBe("42");
  });
});
