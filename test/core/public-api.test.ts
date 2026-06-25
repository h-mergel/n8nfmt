import { describe, expect, it } from "vitest";
import * as api from "../../src/core/index.js";

describe("public API", () => {
  it("exports relayout, serialize, and config helpers", () => {
    expect(typeof api.relayout).toBe("function");
    expect(typeof api.serialize).toBe("function");
    expect(typeof api.buildLayoutConfig).toBe("function");
    expect(api.DEFAULT_CONFIG).toBeDefined();
  });

  it("does NOT export score (internal only)", () => {
    expect("score" in api).toBe(false);
  });
});
