import { describe, expect, it } from "vitest";
import { formatUptime } from "./uptime.js";

describe("formatUptime", () => {
  it("formats zero", () => {
    expect(formatUptime(0)).toBe("0s");
  });

  it("formats seconds only", () => {
    expect(formatUptime(42)).toBe("42s");
  });

  it("formats minutes and seconds", () => {
    expect(formatUptime(125)).toBe("2m 5s");
  });

  it("formats hours with lower zero-valued units", () => {
    expect(formatUptime(3_600)).toBe("1h 0m 0s");
  });

  it("formats days with all lower units", () => {
    expect(formatUptime(93_784)).toBe("1d 2h 3m 4s");
  });

  it("rounds fractional seconds", () => {
    expect(formatUptime(59.6)).toBe("1m 0s");
  });
});
