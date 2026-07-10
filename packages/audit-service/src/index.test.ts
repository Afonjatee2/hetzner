import { describe, expect, it } from "vitest";
import { redactSecrets } from "./index.js";

describe("redactSecrets", () => {
  it("redacts common tokens and assignments", () => {
    expect(redactSecrets("token=super-secret-value sk-1234567890abcdefghijkl")).toBe("[REDACTED] [REDACTED]");
  });
});

