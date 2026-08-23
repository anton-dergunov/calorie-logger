import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DEFAULT_FOOD_VISUAL, foodVisualCatalog } from "./foodVisuals";
import { FoodVisual } from "./foodVisuals";

describe("food pictures", () => {
  it("renders bundled artwork and uses the default picture for unknown values", () => {
    const { rerender } = render(<FoodVisual value="pic:apple" label="Apple" />);
    const appleSource = screen.getByRole("img", { name: "Apple" }).querySelector("img")?.src;
    expect(appleSource?.endsWith(".webp") || appleSource?.startsWith("data:image/webp")).toBe(true);

    // A picture removed from the catalogue, or a value written by an older build, has to resolve
    // to something rather than render an empty box.
    rerender(<FoodVisual value="pic:removed-picture" label="Unknown food" />);
    const fallbackSource = screen.getByRole("img", { name: "Unknown food" }).querySelector("img")?.src;
    rerender(<FoodVisual value={DEFAULT_FOOD_VISUAL} label="Default food" />);
    expect(screen.getByRole("img", { name: "Default food" }).querySelector("img")?.src).toBe(fallbackSource);
  });

  it("bundles artwork for every catalogued picture", () => {
    expect(foodVisualCatalog.length).toBeGreaterThan(90);
    expect(foodVisualCatalog.filter((item) => !item.source)).toEqual([]);
    expect(new Set(foodVisualCatalog.map((item) => item.value)).size).toBe(foodVisualCatalog.length);
    expect(foodVisualCatalog.every((item) => item.value.startsWith("pic:") && item.label && item.keywords.length)).toBe(true);
  });
});
