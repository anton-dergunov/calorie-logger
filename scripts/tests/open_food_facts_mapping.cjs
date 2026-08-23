"use strict";

const assert = require("node:assert/strict");
const { mapOpenFoodFactsProduct: map, validateBarcode } = require("../../pocketbase/pb_hooks/calorie-logger.js");

function product(overrides = {}) {
  return {
    code: "123",
    product_name: "Test food",
    nutriments: {},
    ...overrides,
  };
}

function candidate(result, unit) {
  return result.nutritionCandidates.find((item) => item.unit === unit);
}

const complete = map(product({ nutriments: {
  "energy-kj_100g": 418.4, proteins_100g: 3, fat_100g: 4, carbohydrates_100g: 5,
} }));
assert.ok(Math.abs(candidate(complete, "g").calories - 100) < 1e-10);
assert.deepEqual({ ...candidate(complete, "g"), calories: 100 }, {
  unit: "g", basisAmount: 100, calories: 100, protein: 3, fat: 4, carbs: 5,
});

const partial = map(product({
  serving_quantity: 30, serving_quantity_unit: "g",
  nutriments: { "energy-kcal_100g": 90, proteins_serving: 3 },
}));
assert.deepEqual(candidate(partial, "g"), {
  unit: "g", basisAmount: 100, calories: 90, protein: 10, fat: null, carbs: null,
});

const liquid = map(product({
  product_quantity: 1, product_quantity_unit: "l",
  nutriments: { "energy-kcal_100g": 40, proteins_100g: 1, fat_100g: 1.5, carbohydrates_100g: 6 },
}));
assert.equal(candidate(liquid, "ml").basisAmount, 100);
assert.equal(liquid.preferredUnit, "ml");

const serving = map(product({
  serving_size: "30 g (2 biscuits)", serving_quantity: 30, serving_quantity_unit: "g",
  nutriments: { "energy-kcal_serving": 120, proteins_serving: 2, fat_serving: 4, carbohydrates_serving: 20 },
}));
assert.equal(candidate(serving, "g").basisAmount, 30);
assert.deepEqual(candidate(serving, "item"), {
  unit: "item", basisAmount: 1, calories: 60, protein: 1, fat: 2, carbs: 10,
});
assert.equal(serving.preferredUnit, "item");

const packageItems = map(product({
  quantity: "6 x 25 g", product_quantity: 150, product_quantity_unit: "g",
  nutriments: { "energy-kcal_100g": 200, proteins_100g: 8, fat_100g: 4, carbohydrates_100g: 30 },
}));
assert.deepEqual(candidate(packageItems, "item"), {
  unit: "item", basisAmount: 1, calories: 50, protein: 2, fat: 1, carbs: 7.5,
});

const centilitres = map(product({
  product_quantity: 25, product_quantity_unit: "cl",
  nutriments: { "energy-kcal_100g": 10 },
}));
assert.equal(candidate(centilitres, "ml").basisAmount, 100);
assert.equal(candidate(centilitres, "item"), undefined);

const reportedSoyMilk = map(product({
  code: "5050854584565",
  product_name: "Soya milk",
  quantity: "1l",
  product_quantity: 1000,
  product_quantity_unit: "ml",
  serving_size: "1 serving (400 g)",
  serving_quantity: 400,
  serving_quantity_unit: "g",
  nutrition_data_per: "100ml",
  nutriments: {
    "energy-kcal_100g": 38, proteins_100g: 4, fat_100g: 2.2, carbohydrates_100g: 1,
    "energy-kcal_serving": 152, proteins_serving: 16, fat_serving: 8.8, carbohydrates_serving: 4,
  },
}));
assert.deepEqual(candidate(reportedSoyMilk, "ml"), {
  unit: "ml", basisAmount: 100, calories: 38, protein: 4, fat: 2.2, carbs: 1,
});
assert.match(reportedSoyMilk.warnings[0], /inconsistent portion units/);

const ambiguous = map(product({
  quantity: "family sharing pack",
  nutriments: { "energy-kcal_100g": 100, proteins_100g: 1 },
}));
assert.equal(candidate(ambiguous, "item"), undefined);
assert.equal(candidate(ambiguous, "g").fat, null);

assert.equal(validateBarcode("5012345678900"), "5012345678900");
assert.throws(() => validateBarcode("5012-3456"), /valid EAN or UPC/);
assert.throws(() => validateBarcode("1234567"), /valid EAN or UPC/);

console.log("Open Food Facts nutrition mapping tests passed.");
