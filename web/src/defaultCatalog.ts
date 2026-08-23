import catalogData from "./data/foods.yaml";
import { DEFAULT_FOOD_VISUAL, foodVisualByValue } from "./foodVisuals";
import type { FoodInput, FoodUnit } from "./types";

type CatalogRecord = {
  name: string;
  picture: string;
  unit: FoodUnit;
  basis: number;
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
};

export type DefaultCatalogFood = FoodInput & { id: string };

function hash(text: string, seed: number): number {
  let value = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619) >>> 0;
  }
  return value >>> 0;
}

/**
 * The record id a catalogue food always gets, derived from its name.
 *
 * Seeding has to be able to happen on more than one device — a phone and a laptop can both meet
 * an empty account — and a random id would turn that into two copies of every food that could
 * never be merged. The format matches `newId()` so the server stores it like any other id.
 */
export function seedFoodId(name: string): string {
  const key = name.trim().toLowerCase();
  return [2166136261, 0x9e3779b9, 0x85ebca6b]
    .map((seed) => hash(key, seed).toString(36).padStart(7, "0"))
    .join("")
    .slice(0, 15);
}

/** The catalogue the app starts from, and what a reset restores. Edit `data/foods.yaml`. */
export const defaultCatalog: DefaultCatalogFood[] = (catalogData as CatalogRecord[]).map((item) => {
  const icon = `pic:${item.picture}`;
  return {
    id: seedFoodId(item.name),
    name: item.name,
    icon: foodVisualByValue.has(icon) ? icon : DEFAULT_FOOD_VISUAL,
    basisAmount: item.unit === "item" ? 1 : item.basis,
    unit: item.unit,
    source: null,
    oneOff: false,
    calories: item.calories,
    protein: item.protein,
    fat: item.fat,
    carbs: item.carbs
  };
});
