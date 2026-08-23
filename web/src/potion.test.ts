import { describe, expect, it } from "vitest";
import { foodVisualCatalog } from "./foodVisuals";
import { rankFoodVisuals } from "./potion";

describe("local Potion picture search", () => {
  it("finds relevant pictures for ordinary food descriptions", async () => {
    const best = async (query: string) => (await rankFoodVisuals(query, foodVisualCatalog)).slice(0, 8).map(({ item }) => item.id);

    expect(await best("red apple")).toContain("apple");
    expect(await best("olive oil")).toContain("olive-oil");
    expect(await best("soya drink")).toContain("soy-milk");
    expect((await best("porridge oats")).some((id) => ["cereal", "muesli"].includes(id))).toBe(true);
    expect((await best("wholemeal sourdough")).some((id) => ["bread", "rye-bread", "rye-bread-2"].includes(id))).toBe(true);
  });
});
