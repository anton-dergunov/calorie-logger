import { describe, expect, it } from "vitest";
import { moveDate } from "./date";

describe("calendar navigation", () => {
  it("moves safely over month and leap-year boundaries", () => {
    expect(moveDate("2024-02-28", 1)).toBe("2024-02-29");
    expect(moveDate("2024-02-29", 1)).toBe("2024-03-01");
    expect(moveDate("2025-01-01", -1)).toBe("2024-12-31");
  });
});

