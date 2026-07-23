import { describe, it, expect } from "vitest";
import { formatUptime } from "./uptime.js";

describe("formatUptime", () => {
  it("returns \"0s\" for 0 seconds", () => {
    expect(formatUptime(0)).toBe("0s");
  });

  it("returns \"0s\" for negative input", () => {
    expect(formatUptime(-5)).toBe("0s");
  });

  it("renders seconds only", () => {
    expect(formatUptime(1)).toBe("1s");
    expect(formatUptime(59)).toBe("59s");
  });

  it("renders minutes and seconds, omits zero seconds", () => {
    expect(formatUptime(60)).toBe("1m");
    expect(formatUptime(90)).toBe("1m 30s");
    expect(formatUptime(119)).toBe("1m 59s");
  });

  it("renders hours (with and without minutes/seconds)", () => {
    expect(formatUptime(3600)).toBe("1h");
    expect(formatUptime(3661)).toBe("1h 1m 1s");
    expect(formatUptime(7384)).toBe("2h 3m 4s");
  });

  it("renders days", () => {
    expect(formatUptime(86400)).toBe("1d");
    expect(formatUptime(90061)).toBe("1d 1h 1m 1s");
    expect(formatUptime(93784)).toBe("1d 2h 3m 4s");
  });

  it("truncates fractional input", () => {
    expect(formatUptime(1.9)).toBe("1s");
    expect(formatUptime(60.7)).toBe("1m");
    expect(formatUptime(3661.99)).toBe("1h 1m 1s");
  });
});
