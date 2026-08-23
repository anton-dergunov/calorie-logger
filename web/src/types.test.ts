import { describe, expect, it } from "vitest";
import { contributionLevel, foodContributions, scaledNutrition, sumNutrition, type LogEntry, type Targets } from "./types";

describe("nutrition calculations", () => {
  it("scales a basis to the consumed amount without rounding", () => {
    expect(scaledNutrition({ basisAmount: 100, calories: 120, protein: 8, fat: 3, carbs: 14 }, 250)).toEqual({
      calories: 300,
      protein: 20,
      fat: 7.5,
      carbs: 35
    });
  });

  it("sums all four tracked values", () => {
    expect(sumNutrition([
      { calories: 100, protein: 5, fat: 2, carbs: 10 },
      { calories: 240, protein: 20, fat: 8, carbs: 15 }
    ])).toEqual({ calories: 340, protein: 25, fat: 10, carbs: 25 });
  });
});


const TARGETS: Targets = { calories: 1820, protein: 120, fat: 60, carbs: 200 };

function logged(id: string, foodId: string, fat: number, carbs: number): LogEntry {
  return {
    id, foodId, date: "2026-08-23", name: foodId, icon: "pic:apple", amount: 100, basisAmount: 100,
    unit: "g", calories: 0, protein: 0, fat, carbs, sortIndex: 0, meal: "breakfast",
    createdAt: "2026-08-23T08:00:00.000Z", editedAt: "2026-08-23T08:00:00.000Z"
  };
}

describe("contribution levels", () => {
  it("leaves an ordinary portion below the threshold unflagged", () => {
    expect(contributionLevel(0.194, 20)).toBe(0);
  });

  it("steps at the threshold and at its multiples", () => {
    expect(contributionLevel(0.2, 20)).toBe(1);
    expect(contributionLevel(0.344, 20)).toBe(1);
    expect(contributionLevel(0.35, 20)).toBe(2);
    expect(contributionLevel(0.494, 20)).toBe(2);
    expect(contributionLevel(0.5, 20)).toBe(3);
    expect(contributionLevel(4, 20)).toBe(3);
  });

  it("bands on the percentage it reports, so the tint and the wording never disagree", () => {
    // 34.9% is described as 35% of the target, and is tinted as 35% too.
    expect(contributionLevel(0.349, 20)).toBe(2);
    expect(contributionLevel(0.199, 20)).toBe(1);
  });

  it("widens every band with the threshold rather than only the first", () => {
    expect(contributionLevel(0.35, 40)).toBe(0);
    expect(contributionLevel(0.5, 40)).toBe(1);
    expect(contributionLevel(0.7, 40)).toBe(2);
    expect(contributionLevel(1, 40)).toBe(3);
  });

  it("flags nothing without a target to measure against, or when switched off", () => {
    expect(contributionLevel(null, 20)).toBe(0);
    expect(contributionLevel(0.9, 0)).toBe(0);
  });
});

describe("food contributions", () => {
  it("judges a food by its whole day rather than one helping at a time", () => {
    // Three bananas: 27g of carbohydrate each is unremarkable, 81g against a 200g target is not.
    const contributions = foodContributions([
      logged("a", "banana", 0.4, 27),
      logged("b", "banana", 0.4, 27),
      logged("c", "banana", 0.4, 27)
    ], TARGETS, 20);
    const banana = contributions.get("banana");
    expect(banana?.count).toBe(3);
    expect(banana?.shares.carbs).toBeCloseTo(0.405);
    expect(banana?.levels.carbs).toBe(2);
    expect(banana?.levels.fat).toBe(0);
  });

  it("keeps foods apart and judges each against its own macro", () => {
    const contributions = foodContributions([
      logged("a", "banana", 0.4, 27),
      logged("b", "olive-oil", 14, 0)
    ], TARGETS, 20);
    expect(contributions.get("banana")?.levels.carbs).toBe(0);
    expect(contributions.get("olive-oil")?.levels.fat).toBe(1);
    expect(contributions.get("olive-oil")?.shares.fat).toBeCloseTo(14 / 60);
  });

  it("reports no share for a macro the owner has set no target for", () => {
    const contributions = foodContributions(
      [logged("a", "olive-oil", 40, 0)],
      { ...TARGETS, fat: null },
      20
    );
    expect(contributions.get("olive-oil")?.shares.fat).toBeNull();
    expect(contributions.get("olive-oil")?.levels.fat).toBe(0);
  });
});
