import { describe, expect, it } from "vitest";
import { scaledNutrition, sumNutrition } from "./types";

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

