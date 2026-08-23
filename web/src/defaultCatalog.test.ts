import { describe, expect, it } from "vitest";
import { defaultCatalog, seedFoodId } from "./defaultCatalog";
import { DEFAULT_FOOD_VISUAL, foodVisualByValue } from "./foodVisuals";

describe("default food catalogue", () => {
  it("ships a complete, well formed catalogue", () => {
    expect(defaultCatalog.length).toBeGreaterThan(50);
    for (const food of defaultCatalog) {
      expect(food.name.trim()).toBe(food.name);
      expect(["g", "ml", "item"]).toContain(food.unit);
      expect(food.basisAmount).toBeGreaterThan(0);
      if (food.unit === "item") expect(food.basisAmount).toBe(1);
      for (const value of [food.calories, food.protein, food.fat, food.carbs]) {
        expect(Number.isFinite(value) && value >= 0).toBe(true);
      }
    }
  });

  it("references only bundled pictures", () => {
    // A typo in the YAML must not leave a food with a picture that cannot be drawn.
    const missing = defaultCatalog.filter((food) => !foodVisualByValue.has(food.icon));
    expect(missing).toEqual([]);
    expect(defaultCatalog.filter((food) => food.icon === DEFAULT_FOOD_VISUAL).length).toBeLessThan(5);
  });

  it("gives every food a stable, unique id in the server's id format", () => {
    const ids = defaultCatalog.map((food) => food.id);
    // Two devices can both meet an empty account; identical ids are what make that one catalogue
    // rather than two, so a collision here would silently merge two different foods.
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[a-z0-9]{15}$/.test(id))).toBe(true);
    expect(new Set(defaultCatalog.map((food) => food.name)).size).toBe(defaultCatalog.length);
    expect(seedFoodId("Tofu")).toBe(seedFoodId(" tofu "));
    expect(seedFoodId("Tofu")).not.toBe(seedFoodId("Tempeh"));
  });
});
