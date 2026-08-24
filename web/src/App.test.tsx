import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import App from "./App";
import { localDateString, moveDate } from "./date";
import { localStore } from "./localStore";
import { backendSession, CalorieLoggerApiError, repository } from "./repository";
import { syncEngine } from "./sync";
import type { ExternalFoodSearchResponse, Food, LogEntry, Meal, StoredEntry, SyncFields, Targets } from "./types";
import { DEFAULT_CONTRIBUTION_THRESHOLD } from "./types";
import { foodVisualCatalog } from "./foodVisuals";

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (window as typeof window & { BarcodeDetector?: unknown }).BarcodeDetector;
  sessionStorage.clear();
  syncEngine.stop();
  await localStore.clear();
});

/** A food fixture as a test writes it, without the replication bookkeeping. */
type FoodFixture = Omit<Food, keyof SyncFields | "oneOff"> & { oneOff?: boolean };

function syncFields(editedAt = "2026-08-15T00:00:00.000Z"): SyncFields {
  return { deleted: false, createdAt: editedAt, editedAt, editedBy: "testdevice0000", revision: 1 };
}

/**
 * Fills the local replica the way a first sync would, so tests exercise the same path the app
 * takes when another device's records arrive.
 *
 * Entries are given as the interface shows them; the saved food each one needs is derived back
 * out of the entry when the test has not declared it.
 */
async function seed(data: { day?: { date?: string; entries: LogEntry[]; totals?: unknown }; targets?: Targets; foods?: FoodFixture[]; contributionThreshold?: number } = {}) {
  await localStore.clear();
  await localStore.load("test-owner");
  const foods = new Map<string, Food>((data.foods ?? []).map((food) => [food.id, { oneOff: false, ...food, ...syncFields() }]));
  const entries: StoredEntry[] = (data.day?.entries ?? []).map((item) => {
    if (!foods.has(item.foodId)) {
      const scale = item.basisAmount / item.amount;
      foods.set(item.foodId, {
        id: item.foodId, name: item.name, icon: item.icon, basisAmount: item.basisAmount, unit: item.unit, source: null, oneOff: false,
        calories: item.calories * scale, protein: item.protein * scale, fat: item.fat * scale, carbs: item.carbs * scale,
        ...syncFields()
      });
    }
    return {
      id: item.id, foodId: item.foodId, date: item.date, meal: item.meal,
      sortIndex: item.sortIndex, amount: item.amount, ...syncFields()
    };
  });
  const settings = data.targets
    ? { id: "settings", targets: data.targets, dayRolloverMinutes: 0, contributionThreshold: data.contributionThreshold ?? DEFAULT_CONTRIBUTION_THRESHOLD, ...syncFields() }
    : null;
  await localStore.applyRemote({ foods: [...foods.values()], entries, settings }, 1, "2026-08-15T00:00:00.000Z");
}

function entry(id: string, name: string, meal: Meal, sortIndex: number): LogEntry {
  return {
    id, foodId: `${id}-food`, date: localDateString(), name, icon: "pic:apple", amount: 100,
    basisAmount: 100, unit: "g", calories: 100, protein: 5, fat: 2, carbs: 15,
    sortIndex, meal, createdAt: "2026-08-15T00:00:00.000Z", editedAt: "2026-08-15T00:00:00.000Z"
  };
}

describe("custom food flow", () => {
  it("moves from saving a custom food to the quantity step", async () => {
    const date = localDateString();
    const savedFood: FoodFixture = {
      id: "apple-id",
      name: "Apple",
      icon: "pic:apple",
      basisAmount: 100,
      unit: "g",
      source: null,
      calories: 40,
      protein: 0,
      fat: 0,
      carbs: 10
    };
    const fixture = {
      day: { date, entries: [], totals: { calories: 0, protein: 0, fat: 0, carbs: 0 } },
      targets: { calories: 1850, protein: 140, fat: 50, carbs: 210 },
      foods: [savedFood]
    };

    await seed(fixture);
    const saveFood = vi.spyOn(repository, "saveFood").mockResolvedValue({ oneOff: false, ...savedFood, ...syncFields() });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Add food to Breakfast" }));
    fireEvent.click(screen.getByRole("button", { name: /Create a food by hand/ }));
    const foodName = screen.getByLabelText("Food name");
    expect(foodName.getAttribute("type")).toBe("search");
    expect(foodName.getAttribute("role")).toBe("textbox");
    expect(foodName.classList.contains("android-input-workaround")).toBe(true);
    expect(foodName.getAttribute("inputmode")).toBe("text");
    expect(foodName.getAttribute("autocomplete")).toBe("off");
    expect(foodName.getAttribute("autocapitalize")).toBe("words");
    expect(foodName.getAttribute("enterkeyhint")).toBe("next");
    fireEvent.change(foodName, { target: { value: "Apple" } });
    expect(screen.getByLabelText("Nutrition basis amount").getAttribute("inputmode")).toBe("decimal");
    expect(screen.getByLabelText("Nutrition basis amount").getAttribute("autocomplete")).toBe("off");
    const numericInputs = screen.getAllByRole("spinbutton");
    expect(numericInputs.every((input) => input.getAttribute("type") === "search" && input.classList.contains("android-input-workaround"))).toBe(true);
    fireEvent.change(numericInputs[1], { target: { value: "40" } });
    fireEvent.change(numericInputs[2], { target: { value: "0" } });
    fireEvent.change(numericInputs[3], { target: { value: "0" } });
    fireEvent.change(numericInputs[4], { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(saveFood).toHaveBeenCalledOnce());
    expect(await screen.findByText("Selected food")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Add to day" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Choose a different food" })).not.toBeNull();
    expect(screen.queryByText(/^Nutrition per /)).toBeNull();
    const amount = screen.getByRole("spinbutton") as HTMLInputElement;
    expect(amount.value).toBe("100");
    expect(amount.getAttribute("inputmode")).toBe("decimal");
    expect(amount.getAttribute("autocomplete")).toBe("off");
    expect(amount.getAttribute("enterkeyhint")).toBe("done");
    expect(amount.getAttribute("type")).toBe("search");
  });

  it("derives calories from macros and preserves a manual draft while changing units", async () => {
    const date = localDateString();
    await seed({
      day: { date, entries: [], totals: { calories: 0, protein: 0, fat: 0, carbs: 0 } },
      targets: { calories: null, protein: null, fat: null, carbs: null },
      foods: []
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Add food to Breakfast" }));
    fireEvent.click(screen.getByRole("button", { name: /Create a food by hand/ }));
    fireEvent.change(screen.getByLabelText("Food name"), { target: { value: "Draft oats" } });
    fireEvent.change(screen.getByLabelText("Nutrition basis amount"), { target: { value: "75" } });
    fireEvent.change(screen.getByLabelText("Protein"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Fat"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Carbs"), { target: { value: "4" } });
    expect((screen.getByLabelText("Calories") as HTMLInputElement).value).toBe("51");

    fireEvent.change(screen.getByLabelText("Calories"), { target: { value: "52" } });
    const unit = screen.getByLabelText("Nutrition unit") as HTMLSelectElement;
    fireEvent.change(unit, { target: { value: "ml" } });
    expect((screen.getByLabelText("Nutrition basis amount") as HTMLInputElement).value).toBe("75");
    expect((screen.getByLabelText("Calories") as HTMLInputElement).value).toBe("52");
    expect((screen.getByLabelText("Protein") as HTMLInputElement).value).toBe("2");
    expect((screen.getByLabelText("Fat") as HTMLInputElement).value).toBe("3");
    expect((screen.getByLabelText("Carbs") as HTMLInputElement).value).toBe("4");

    fireEvent.change(unit, { target: { value: "item" } });
    expect((screen.getByLabelText("Nutrition basis amount") as HTMLInputElement).value).toBe("1");
    expect((screen.getByLabelText("Calories") as HTMLInputElement).value).toBe("52");
    fireEvent.change(unit, { target: { value: "g" } });
    expect((screen.getByLabelText("Nutrition basis amount") as HTMLInputElement).value).toBe("75");
    expect((screen.getByLabelText("Calories") as HTMLInputElement).value).toBe("52");

  });

  // The editor used to be mounted for the rest of the dialog's life and merely marked `hidden`,
  // which a stylesheet `display` silently defeated: a blank form sat above the catalogue and the
  // search results, demanding a food name, with a Back button that went nowhere.
  it("leaves no editor behind after going back to the food search", async () => {
    await seed({
      day: { date: localDateString(), entries: [], totals: { calories: 0, protein: 0, fat: 0, carbs: 0 } },
      targets: { calories: null, protein: null, fat: null, carbs: null },
      foods: []
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Add food to Breakfast" }));
    fireEvent.click(screen.getByRole("button", { name: /Create a food by hand/ }));
    fireEvent.change(screen.getByLabelText("Food name"), { target: { value: "Draft oats" } });

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(screen.queryByLabelText("Food name")).toBeNull();
    expect(screen.queryByRole("region", { name: "Create a food" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByRole("searchbox", { name: "Search foods" })).not.toBeNull();

    // Reopening starts clean rather than resurrecting the abandoned draft.
    fireEvent.click(screen.getByRole("button", { name: /Create a food by hand/ }));
    expect((screen.getByLabelText("Food name") as HTMLInputElement).value).toBe("");
  });
});

describe("external food search", () => {
  it("searches only on submit and preserves results while a food is reviewed", async () => {
    const date = localDateString();
    const savedFood: FoodFixture = {
      id: "saved-oats", name: "Porridge oats", icon: "pic:cereal", basisAmount: 100, unit: "g", source: null,
      calories: 370, protein: 13, fat: 7, carbs: 62,
      };
    const fixture = {
      day: { date, entries: [], totals: { calories: 0, protein: 0, fat: 0, carbs: 0 } },
      targets: { calories: null, protein: null, fat: null, carbs: null },
      foods: []
    };
    const source = { provider: "cofid" as const, id: "11-005", label: "CoFID 2021", url: "https://www.gov.uk/government/publications/composition-of-foods-integrated-dataset-cofid" };
    const externalResult = {
      id: "cofid:11-005", source, name: "Porridge oats", detail: "Rolled oats", photoURL: null,
      preferredUnit: "g" as const,
      nutritionCandidates: [{ unit: "g" as const, basisAmount: 100, calories: 370, protein: 13, fat: 7, carbs: 62 }]
    };
    const response: ExternalFoodSearchResponse = {
      results: [externalResult],
      errors: [{ source: "openFoodFacts", code: "temporarily_unavailable", message: "Open Food Facts is unavailable. Showing CoFID results.", retryable: false }]
    };

    await seed(fixture);
    const search = vi.spyOn(repository, "searchExternalFoods").mockResolvedValue(response);
    const saveFood = vi.spyOn(repository, "saveFood").mockResolvedValue({ oneOff: false, ...savedFood, ...syncFields() });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Add food to Breakfast" }));
    const query = screen.getByRole("searchbox", { name: "Search foods" });
    expect(query.getAttribute("inputmode")).toBe("search");
    expect(query.getAttribute("autocomplete")).toBe("off");
    expect(query.getAttribute("enterkeyhint")).toBe("search");
    expect(query.classList.contains("android-input-workaround")).toBe(true);
    fireEvent.change(query, { target: { value: "porridge oats" } });
    expect(search).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Search food databases/ }));

    expect(await screen.findByText("Porridge oats")).not.toBeNull();
    expect(search).toHaveBeenCalledWith("porridge oats");
    expect(screen.getByText(/Open Food Facts is unavailable/)).not.toBeNull();
    // A CoFID result has to be shown under its own heading. Merged into one list it sat below
    // every Open Food Facts product and was never seen.
    expect(screen.getByRole("heading", { name: "Generic foods", level: 4 })).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Products", level: 4 })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Porridge oats/ }));
    // The step names itself in the header, in one line that never depends on how long the food's
    // name or its source's name happens to be. The source is credited under the fields instead.
    expect(await screen.findByRole("heading", { name: "New food", level: 2 })).not.toBeNull();
    expect(screen.getByText(/Derived from/).textContent).toContain("CoFID 2021");
    expect((screen.getByLabelText("Food name") as HTMLInputElement).value).toBe("Porridge oats");

    // Back returns to the search that found it, with the results and the query intact.
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByText("Rolled oats")).not.toBeNull();
    expect((screen.getByRole("searchbox", { name: "Search foods" }) as HTMLInputElement).value).toBe("porridge oats");

    fireEvent.click(screen.getByRole("button", { name: /Porridge oats/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveFood).toHaveBeenCalledWith(expect.objectContaining({ name: "Porridge oats", source }), undefined));
    expect(await screen.findByText("Selected food")).not.toBeNull();
    expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("100");
  });

  it("keeps transient unit candidates and manual edits separate and saves only the chosen unit", async () => {
    const date = localDateString();
    const source = { provider: "openFoodFacts" as const, id: "123", label: "Open Food Facts", url: "https://world.openfoodfacts.org/product/123" };
    const result = {
      id: "openFoodFacts:123", source, name: "Apple portions", detail: "123", photoURL: "https://images.openfoodfacts.org/apple.jpg",
      preferredUnit: "g" as const,
      nutritionCandidates: [
        { unit: "g" as const, basisAmount: 100, calories: 52, protein: 0.3, fat: 0.2, carbs: 14 },
        { unit: "item" as const, basisAmount: 1, calories: 78, protein: 0.45, fat: 0.3, carbs: 21 }
      ]
    };
    const fixture = {
      day: { date, entries: [], totals: { calories: 0, protein: 0, fat: 0, carbs: 0 } },
      targets: { calories: null, protein: null, fat: null, carbs: null }, foods: []
    };
    const saved: FoodFixture = {
      id: "saved", name: result.name, icon: "pic:apple", basisAmount: 1, unit: "item", source,
      calories: 79, protein: 0.45, fat: 0.3, carbs: 21
    };
    await seed(fixture);
    vi.spyOn(repository, "searchExternalFoods").mockResolvedValue({ results: [result], errors: [] });
    const saveFood = vi.spyOn(repository, "saveFood").mockResolvedValue({ oneOff: false, ...saved, ...syncFields() });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Add food to Breakfast" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search foods" }), { target: { value: "apple" } });
    fireEvent.click(screen.getByRole("button", { name: /Search food databases/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Apple portions/ }));

    const unit = screen.getByLabelText("Nutrition unit") as HTMLSelectElement;
    fireEvent.change(unit, { target: { value: "item" } });
    expect((screen.getByLabelText("Nutrition basis amount") as HTMLInputElement).value).toBe("1");
    expect((screen.getByLabelText("Calories") as HTMLInputElement).value).toBe("78");
    fireEvent.change(screen.getByLabelText("Calories"), { target: { value: "79" } });
    fireEvent.change(unit, { target: { value: "g" } });
    expect((screen.getByLabelText("Calories") as HTMLInputElement).value).toBe("52");
    fireEvent.change(unit, { target: { value: "item" } });
    expect((screen.getByLabelText("Calories") as HTMLInputElement).value).toBe("79");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(saveFood).toHaveBeenCalledWith(expect.objectContaining({
      unit: "item", basisAmount: 1, calories: 79, source
    }), undefined));
  });

  it("rounds imported nutrition to one decimal before offering it for review", async () => {
    // Providers report their own precision, and rebasing a per-serving figure onto 100 g adds
    // several digits more, so the editor used to open on values like 282.5688 kcal that no
    // package label has ever carried. What is shown rounded is also what is saved.
    const date = localDateString();
    const source = { provider: "openFoodFacts" as const, id: "77", label: "Open Food Facts", url: "https://world.openfoodfacts.org/product/77" };
    const result = {
      id: "openFoodFacts:77", source, name: "Margherita pizza", detail: "77", photoURL: null,
      preferredUnit: "g" as const,
      nutritionCandidates: [{ unit: "g" as const, basisAmount: 30.75, calories: 282.5688, protein: 12.4898, fat: 8.3265, carbs: 33.2245 }]
    };
    const saved: FoodFixture = {
      id: "saved-pizza", name: result.name, icon: "pic:bread", basisAmount: 30.8, unit: "g", source,
      calories: 282.6, protein: 12.5, fat: 8.3, carbs: 33.2
    };
    await seed({
      day: { date, entries: [], totals: { calories: 0, protein: 0, fat: 0, carbs: 0 } },
      targets: { calories: null, protein: null, fat: null, carbs: null }, foods: []
    });
    vi.spyOn(repository, "searchExternalFoods").mockResolvedValue({ results: [result], errors: [] });
    const saveFood = vi.spyOn(repository, "saveFood").mockResolvedValue({ oneOff: false, ...saved, ...syncFields() });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Add food to Breakfast" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search foods" }), { target: { value: "margherita" } });
    fireEvent.click(screen.getByRole("button", { name: /Search food databases/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Margherita pizza/ }));

    expect((await screen.findByLabelText("Nutrition basis amount") as HTMLInputElement).value).toBe("30.8");
    expect((screen.getByLabelText("Calories") as HTMLInputElement).value).toBe("282.6");
    expect((screen.getByLabelText("Protein") as HTMLInputElement).value).toBe("12.5");
    expect((screen.getByLabelText("Fat") as HTMLInputElement).value).toBe("8.3");
    expect((screen.getByLabelText("Carbs") as HTMLInputElement).value).toBe("33.2");

    // Typing is not rounded: a person who wants more precision than a label carries keeps it.
    fireEvent.change(screen.getByLabelText("Calories"), { target: { value: "282.5688" } });
    expect((screen.getByLabelText("Calories") as HTMLInputElement).value).toBe("282.5688");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveFood).toHaveBeenCalledWith(expect.objectContaining({
      basisAmount: 30.8, calories: 282.5688, protein: 12.5, fat: 8.3, carbs: 33.2
    }), undefined));
  });

  it("opens an exact-source match as the existing food instead of creating a duplicate", async () => {
    const date = localDateString();
    const source = { provider: "openFoodFacts" as const, id: "5012345678900", label: "Open Food Facts", url: "https://world.openfoodfacts.org/product/5012345678900" };
    const existing: FoodFixture = {
      id: "saved-bar", name: "My oat bar", icon: "pic:energy-bar", basisAmount: 40, unit: "g", source,
      calories: 160, protein: 3, fat: 5, carbs: 26
    };
    const result = {
      id: "off:5012345678900", source, name: "Manufacturer oat bar", detail: "40 g · 5012345678900", photoURL: null,
      preferredUnit: "g" as const,
      nutritionCandidates: [{ unit: "g" as const, basisAmount: 100, calories: 410, protein: 8, fat: 13, carbs: 66 }]
    };
    await seed({
      day: { date, entries: [], totals: { calories: 0, protein: 0, fat: 0, carbs: 0 } },
      targets: { calories: null, protein: null, fat: null, carbs: null }, foods: [existing]
    });
    vi.spyOn(repository, "searchExternalFoods").mockResolvedValue({ results: [result], errors: [] });
    const save = vi.spyOn(repository, "saveFood").mockResolvedValue({ oneOff: false, ...existing, ...syncFields() });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Add food to Breakfast" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search foods" }), { target: { value: "oat bar" } });
    fireEvent.click(screen.getByRole("button", { name: /Search food databases/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Manufacturer oat bar/ }));

    expect(await screen.findByText("Already in your catalogue")).not.toBeNull();
    expect((screen.getByLabelText("Food name") as HTMLInputElement).value).toBe("My oat bar");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: "My oat bar", source }), existing.id));
  });
});

describe("finding a food to log", () => {
  const oats: FoodFixture = {
    id: "oats-id", name: "Porridge oats", icon: "pic:cereal", basisAmount: 100, unit: "g",
    source: null, calories: 370, protein: 13, fat: 7, carbs: 62
  };
  const apple: FoodFixture = {
    id: "apple-id", name: "Apple", icon: "pic:apple", basisAmount: 1, unit: "item",
    source: null, calories: 95, protein: 0.5, fat: 0.3, carbs: 25
  };

  async function openPicker(foods: FoodFixture[], entries: LogEntry[] = []) {
    await seed({
      day: { date: localDateString(), entries, totals: { calories: 0, protein: 0, fat: 0, carbs: 0 } },
      targets: { calories: null, protein: null, fat: null, carbs: null },
      foods
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Add food to Breakfast" }));
  }

  // One field, and the databases are only reached when asked. Searching on every keystroke would
  // spend the Open Food Facts rate limit on prefixes nobody meant to search for.
  it("filters saved foods as you type and only reaches the databases on request", async () => {
    const search = vi.spyOn(repository, "searchExternalFoods");
    await openPicker([oats, apple]);

    const query = screen.getByRole("searchbox", { name: "Search foods" });
    fireEvent.change(query, { target: { value: "porr" } });

    expect(screen.getByRole("button", { name: /^Porridge oats/ })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /^Apple/ })).toBeNull();
    expect(search).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Search food databases/ })).not.toBeNull();
  });

  it("presses Enter on a matching query without spending a database search", async () => {
    const search = vi.spyOn(repository, "searchExternalFoods");
    await openPicker([oats, apple]);

    const query = screen.getByRole("searchbox", { name: "Search foods" });
    fireEvent.change(query, { target: { value: "porridge" } });
    fireEvent.submit(query.closest("form")!);

    expect(search).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^Porridge oats/ })).not.toBeNull();
  });

  it("presses Enter on a query nothing of yours matches and searches the databases", async () => {
    const search = vi.spyOn(repository, "searchExternalFoods").mockResolvedValue({ results: [], errors: [] });
    await openPicker([oats, apple]);

    const query = screen.getByRole("searchbox", { name: "Search foods" });
    fireEvent.change(query, { target: { value: "appletiser" } });
    fireEvent.submit(query.closest("form")!);

    await waitFor(() => expect(search).toHaveBeenCalledWith("appletiser"));
    expect(await screen.findByText(/No database matches/)).not.toBeNull();
  });

  // The catalogue beside the amount panel has to read as "this food, with alternatives around
  // it", not as an unrelated list.
  it("marks the chosen food in the list beside the amount", async () => {
    await openPicker([oats, apple]);

    fireEvent.click(screen.getByRole("button", { name: /^Porridge oats/ }));

    expect(await screen.findByText("Selected food")).not.toBeNull();
    const chosen = screen.getByRole("button", { name: /^Porridge oats/ });
    expect(chosen.getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: /^Apple/ }).getAttribute("aria-current")).toBeNull();
  });

  // Searching does not clear the selection, so the editor used to open beside a food the person
  // had stopped looking at, offering to log it.
  it("does not leave a previously chosen food beside the editor", async () => {
    const source = { provider: "openFoodFacts" as const, id: "1", label: "Open Food Facts", url: "https://world.openfoodfacts.org/product/1" };
    const search = vi.spyOn(repository, "searchExternalFoods").mockResolvedValue({
      results: [{
        id: "off:1", source, name: "Ristorante Pizza Vegetale", detail: null, photoURL: null,
        preferredUnit: "g" as const,
        nutritionCandidates: [{ unit: "g" as const, basisAmount: 100, calories: 193, protein: 6.7, fat: 7.9, carbs: 22 }]
      }],
      errors: []
    });
    await openPicker([oats, apple]);

    fireEvent.click(screen.getByRole("button", { name: /^Porridge oats/ }));
    expect(await screen.findByText("Selected food")).not.toBeNull();

    const query = screen.getByRole("searchbox", { name: "Search foods" });
    fireEvent.change(query, { target: { value: "pizza vegetale" } });
    fireEvent.click(screen.getByRole("button", { name: /Search food databases/ }));
    await waitFor(() => expect(search).toHaveBeenCalled());
    // Choosing a food and then searching is not choosing a different food.
    expect(screen.getByText("Selected food")).not.toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: /Ristorante Pizza Vegetale/ }));

    await screen.findByRole("region", { name: "Review food" });
    expect(screen.queryByText("Selected food")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add to day" })).toBeNull();

    // The selection is kept, not discarded, so leaving the editor returns to it.
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByText("Selected food")).not.toBeNull();
  });

  it("offers the amount last logged for a food, and its basis amount when it has never been logged", async () => {
    const logged: LogEntry = {
      id: "oats-entry", foodId: oats.id, date: localDateString(), name: oats.name, icon: oats.icon,
      amount: 65, basisAmount: 100, unit: "g", calories: 240.5, protein: 8.45, fat: 4.55, carbs: 40.3,
      sortIndex: 0, meal: "breakfast", createdAt: "2026-08-15T00:00:00.000Z", editedAt: "2026-08-15T00:00:00.000Z"
    };
    await openPicker([oats, apple], [logged]);

    fireEvent.click(screen.getByRole("button", { name: /^Porridge oats/ }));
    expect((await screen.findByLabelText("Amount consumed") as HTMLInputElement).value).toBe("65");

    fireEvent.click(screen.getByRole("button", { name: /^Apple/ }));
    expect((screen.getByLabelText("Amount consumed") as HTMLInputElement).value).toBe("1");
  });

  // Saving a food is a catalogue write, not a log write. Landing on the amount step is an offer.
  it("saves a food without logging anything, and offers it for the amount", async () => {
    const addEntry = vi.spyOn(repository, "addEntry");
    await openPicker([apple]);

    fireEvent.click(screen.getByRole("button", { name: /Create a food by hand/ }));
    fireEvent.change(screen.getByLabelText("Food name"), { target: { value: "Rye bread" } });
    fireEvent.change(screen.getByLabelText("Calories"), { target: { value: "250" } });
    fireEvent.change(screen.getByLabelText("Protein"), { target: { value: "9" } });
    fireEvent.change(screen.getByLabelText("Fat"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Carbs"), { target: { value: "48" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Selected food")).not.toBeNull();
    expect(addEntry).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Amount consumed") as HTMLInputElement).value).toBe("100");
    // And the way back to what was just created, without hunting for it in the list.
    expect(screen.getByRole("button", { name: "Edit selected food" })).not.toBeNull();
  });

  // The field takes a description as readily as a name, so it is as tall as what was typed
  // rather than a one-line slot the text scrolls through.
  it("grows the search field with the text typed into it", async () => {
    await openPicker([oats]);
    const query = screen.getByRole("searchbox", { name: "Search foods" }) as HTMLTextAreaElement;
    expect(query.tagName).toBe("TEXTAREA");

    Object.defineProperty(query, "scrollHeight", { configurable: true, value: 96 });
    fireEvent.change(query, { target: { value: "a bowl of porridge with a sliced banana and a spoon of honey" } });

    await waitFor(() => expect(query.style.height).toBe("96px"));
  });

  it("keeps one-off foods out of the food list but still logs and edits them", async () => {
    const leftovers: FoodFixture = {
      id: "leftovers-id", name: "Leftover curry", icon: "pic:apple", basisAmount: 1, unit: "item",
      source: null, oneOff: true, calories: 520, protein: 21, fat: 18, carbs: 62
    };
    const logged: LogEntry = {
      id: "leftovers-entry", foodId: leftovers.id, date: localDateString(), name: leftovers.name,
      icon: leftovers.icon, amount: 1, basisAmount: 1, unit: "item", calories: 520, protein: 21, fat: 18,
      carbs: 62, sortIndex: 0, meal: "breakfast", createdAt: "2026-08-15T00:00:00.000Z", editedAt: "2026-08-15T00:00:00.000Z"
    };
    await openPicker([oats, leftovers], [logged]);

    expect(screen.queryByRole("button", { name: /^Leftover curry/ })).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search foods" }), { target: { value: "curry" } });
    expect(screen.queryByRole("button", { name: /^Leftover curry/ })).toBeNull();

    // It is still reachable through the entry that uses it, tagged for what it is.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit Leftover curry" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit selected food" }));
    expect(await screen.findByText("One-off")).not.toBeNull();
    expect((screen.getByLabelText("Add to my catalogue") as HTMLInputElement).checked).toBe(false);
  });

  it("offers the three ways to add what was typed, above the catalogue", async () => {
    await openPicker([oats]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search foods" }), { target: { value: "porridge" } });

    const actions = screen.getAllByRole("button").map((button) => button.textContent ?? "");
    const estimate = actions.findIndex((label) => label.startsWith("Estimate it with AI"));
    const byHand = actions.findIndex((label) => label.startsWith("Enter the numbers myself"));
    const databases = actions.findIndex((label) => label.startsWith("Search food databases"));
    const catalogue = actions.findIndex((label) => label.startsWith("Porridge oats"));
    expect(estimate).toBeGreaterThanOrEqual(0);
    expect(byHand).toBeGreaterThan(estimate);
    expect(databases).toBeGreaterThan(byHand);
    expect(catalogue).toBeGreaterThan(databases);
  });

  // Typed by hand from the group above: what is typed is the portion eaten, and it stays out of
  // the catalogue unless asked for.
  it("creates a hand-typed portion as a one-off measured per item", async () => {
    const saveFood = vi.spyOn(repository, "saveFood");
    await openPicker([oats]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search foods" }), { target: { value: "canteen stew" } });
    fireEvent.click(screen.getByRole("button", { name: /Enter the numbers myself/ }));

    expect((screen.getByLabelText("Add to my catalogue") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("Nutrition unit") as HTMLSelectElement).value).toBe("item");
    fireEvent.change(screen.getByLabelText("Food name"), { target: { value: "Canteen stew" } });
    fireEvent.change(screen.getByLabelText("Protein"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("Fat"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Carbs"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(saveFood).toHaveBeenCalled());
    expect(saveFood.mock.calls[0][0]).toMatchObject({
      name: "Canteen stew", oneOff: true, unit: "item", basisAmount: 1,
      // Energy is calculated from the macros, here as everywhere else.
      calories: 290, protein: 20, fat: 10, carbs: 30
    });
  });

  // A one-off is invisible in the food list, so one left behind by closing the dialog could
  // never be reached again.
  it("discards a one-off that was created and then not logged", async () => {
    const deleteFood = vi.spyOn(repository, "deleteFood");
    await openPicker([oats]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search foods" }), { target: { value: "canteen stew" } });
    fireEvent.click(screen.getByRole("button", { name: /Enter the numbers myself/ }));
    fireEvent.change(screen.getByLabelText("Food name"), { target: { value: "Canteen stew" } });
    fireEvent.change(screen.getByLabelText("Protein"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("Fat"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Carbs"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Selected food");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(deleteFood).toHaveBeenCalledTimes(1));
    expect(localStore.day(localDateString()).entries).toHaveLength(0);
  });

  it("keeps a one-off that was logged", async () => {
    const deleteFood = vi.spyOn(repository, "deleteFood");
    await openPicker([oats]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search foods" }), { target: { value: "canteen stew" } });
    fireEvent.click(screen.getByRole("button", { name: /Enter the numbers myself/ }));
    fireEvent.change(screen.getByLabelText("Food name"), { target: { value: "Canteen stew" } });
    fireEvent.change(screen.getByLabelText("Protein"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("Fat"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Carbs"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Selected food");
    fireEvent.click(screen.getByRole("button", { name: "Add to day" }));

    await waitFor(() => expect(localStore.day(localDateString()).entries).toHaveLength(1));
    expect(deleteFood).not.toHaveBeenCalled();
    expect(localStore.day(localDateString()).entries[0]).toMatchObject({ name: "Canteen stew", amount: 1, unit: "item" });
  });

  it("estimates a described portion and opens it for review", async () => {
    const estimate = vi.spyOn(repository, "estimateFood").mockResolvedValue({
      recognised: true, name: "Porridge with banana and honey", portion: "1 medium bowl, about 250 g",
      protein: 13.5, fat: 9.2, carbs: 78.5, confidence: "medium", note: null
    });
    const saveFood = vi.spyOn(repository, "saveFood");
    await openPicker([oats]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search foods" }), { target: { value: "a bowl of porridge\nwith  honey" } });
    fireEvent.click(screen.getByRole("button", { name: /Estimate it with AI/ }));

    // The description reaches the server as one line, whatever it was typed as.
    await waitFor(() => expect(estimate).toHaveBeenCalledWith({ description: "a bowl of porridge with honey" }));
    expect(await screen.findByText(/Estimated from your description/)).not.toBeNull();
    expect(screen.getByText(/1 medium bowl, about 250 g/)).not.toBeNull();
    expect((screen.getByLabelText("Food name") as HTMLInputElement).value).toBe("Porridge with banana and honey");
    expect((screen.getByLabelText("Protein") as HTMLInputElement).value).toBe("13.5");
    expect((screen.getByLabelText("Calories") as HTMLInputElement).value).toBe("450.8");
    expect((screen.getByLabelText("Add to my catalogue") as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveFood).toHaveBeenCalled());
    expect(saveFood.mock.calls[0][0]).toMatchObject({ oneOff: true, unit: "item", basisAmount: 1, protein: 13.5 });
  });

  // Nothing else in the picker depends on the estimator, so its failure is reported where it
  // happened rather than as a failure of the app.
  it("reports an estimate that could not be made without disturbing the rest of the picker", async () => {
    vi.spyOn(repository, "estimateFood").mockRejectedValue(
      new CalorieLoggerApiError("This server has no food estimator configured.", 424, "estimator_unavailable")
    );
    await openPicker([oats]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search foods" }), { target: { value: "porridge" } });
    fireEvent.click(screen.getByRole("button", { name: /Estimate it with AI/ }));

    expect(await screen.findByText("This server has no food estimator configured.")).not.toBeNull();
    expect(screen.getByRole("button", { name: /^Porridge oats/ })).not.toBeNull();
  });
});

describe("the camera", () => {
  const source = { provider: "openFoodFacts" as const, id: "5012345678900", label: "Open Food Facts", url: "https://world.openfoodfacts.org/product/5012345678900" };
  const product = {
    id: "off:5012345678900", source, name: "Scanned oat bar", detail: "40 g \u00b7 5012345678900", photoURL: null,
    preferredUnit: "g" as const,
    nutritionCandidates: [{ unit: "g" as const, basisAmount: 100, calories: 410, protein: 8, fat: 13, carbs: 66 }],
    warnings: ["Open Food Facts has inconsistent portion units for this product. Check the nutrition basis against the package before saving."]
  };

  function mockCamera({ barcode = "5012345678900" }: { barcode?: string | null } = {}) {
    const stop = vi.fn();
    vi.stubGlobal("navigator", {
      userAgent: "test", platform: "test", maxTouchPoints: 0,
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue([{ kind: "videoinput" }]),
        getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] })
      }
    });
    class Detector {
      static getSupportedFormats = vi.fn().mockResolvedValue(["ean_13", "ean_8", "upc_a", "upc_e"]);
      detect = vi.fn().mockResolvedValue(barcode ? [{ rawValue: barcode }] : []);
    }
    (window as typeof window & { BarcodeDetector?: unknown }).BarcodeDetector = Detector;
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockReturnValue(640);
    vi.spyOn(HTMLVideoElement.prototype, "videoHeight", "get").mockReturnValue(480);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(), getImageData: vi.fn().mockReturnValue({ data: new Uint8ClampedArray(4), width: 1, height: 1 })
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,QUJD");
    return { stop };
  }

  async function openCamera(query?: string) {
    await seed({
      day: { date: localDateString(), entries: [], totals: { calories: 0, protein: 0, fat: 0, carbs: 0 } },
      targets: { calories: null, protein: null, fat: null, carbs: null }, foods: []
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Add food to Breakfast" }));
    const open = await screen.findByRole("button", { name: "Scan a barcode or photograph food" });
    if (query) fireEvent.change(screen.getByRole("searchbox", { name: "Search foods" }), { target: { value: query } });
    fireEvent.click(open);
    return screen.findByRole("region", { name: "Camera" });
  }

  // Pointing at a packet is not the same as asking about the packet: the photograph is just as
  // likely to be the point, so the camera keeps running behind the offer.
  it("offers a detected barcode without taking the camera over, and looks it up on request", async () => {
    const { stop } = mockCamera();
    const lookup = vi.spyOn(repository, "lookupExternalFood").mockResolvedValue(product);
    await openCamera();

    expect(await screen.findByText("Barcode 5012345678900")).not.toBeNull();
    expect(stop).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Estimate this photo with AI" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Look up product" }));
    expect(await screen.findByText("Check the package label")).not.toBeNull();
    expect(lookup).toHaveBeenCalledWith("5012345678900");
    // A product is a catalogue food unless it is said otherwise.
    expect((screen.getByLabelText("Add to my catalogue") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("region", { name: "Camera" })).not.toBeNull();
  });

  it("keeps scanning after a barcode is dismissed, and does not offer it again", async () => {
    mockCamera();
    await openCamera();
    expect(await screen.findByText("Barcode 5012345678900")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Not this one" }));

    await waitFor(() => expect(screen.queryByText("Barcode 5012345678900")).toBeNull());
    // The same packet is still in shot and the decoder keeps returning it; it must stay dismissed.
    await new Promise((resolve) => window.setTimeout(resolve, 400));
    expect(screen.queryByText("Barcode 5012345678900")).toBeNull();
    expect(screen.getByRole("button", { name: "Estimate this photo with AI" })).not.toBeNull();
  });

  it("photographs the food, sends the typed description with it, and opens the estimate", async () => {
    mockCamera({ barcode: null });
    const estimate = vi.spyOn(repository, "estimateFood").mockResolvedValue({
      recognised: true, name: "Rice with tandoori curry and paneer", portion: "1 plate, about 450 g",
      protein: 24, fat: 26, carbs: 98, confidence: "medium", note: null
    });
    await openCamera("moderate portion");

    fireEvent.click(await screen.findByRole("button", { name: "Estimate this photo with your description" }));

    await waitFor(() => expect(estimate).toHaveBeenCalledWith({
      description: "moderate portion",
      image: { mimeType: "image/jpeg", data: "QUJD" }
    }));
    expect(await screen.findByText(/Estimated from your description/)).not.toBeNull();
    expect((screen.getByLabelText("Food name") as HTMLInputElement).value).toBe("Rice with tandoori curry and paneer");
    expect((screen.getByLabelText("Add to my catalogue") as HTMLInputElement).checked).toBe(false);
  });

  it("reports a photo the model could not read, and offers another", async () => {
    mockCamera({ barcode: null });
    vi.spyOn(repository, "estimateFood").mockResolvedValue({
      recognised: false, name: "", portion: "", protein: 0, fat: 0, carbs: 0,
      confidence: "low", note: "That photo does not show any food."
    });
    await openCamera();

    fireEvent.click(await screen.findByRole("button", { name: "Estimate this photo with AI" }));

    expect(await screen.findByText("That photo does not show any food.")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Take another photo" })).not.toBeNull();
  });

  it("does not offer the camera when no video input is reported", async () => {
    const date = localDateString();
    const enumerateDevices = vi.fn().mockResolvedValue([]);
    vi.stubGlobal("navigator", {
      userAgent: "test", platform: "test", maxTouchPoints: 0,
      mediaDevices: { enumerateDevices, getUserMedia: vi.fn() }
    });
    await seed({
      day: { date, entries: [], totals: { calories: 0, protein: 0, fat: 0, carbs: 0 } },
      targets: { calories: null, protein: null, fat: null, carbs: null }, foods: []
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Add food to Breakfast" }));
    await waitFor(() => expect(enumerateDevices).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Scan a barcode or photograph food" })).toBeNull();
  });

  it("explains camera permission denial and allows retry", async () => {
    const date = localDateString();
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
    vi.stubGlobal("navigator", {
      userAgent: "test", platform: "test", maxTouchPoints: 0,
      mediaDevices: { enumerateDevices: vi.fn().mockResolvedValue([{ kind: "videoinput" }]), getUserMedia }
    });
    await seed({
      day: { date, entries: [], totals: { calories: 0, protein: 0, fat: 0, carbs: 0 } },
      targets: { calories: null, protein: null, fat: null, carbs: null }, foods: []
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Add food to Breakfast" }));
    fireEvent.click(await screen.findByRole("button", { name: "Scan a barcode or photograph food" }));
    expect(await screen.findByText(/Camera access was not allowed/)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
  });
});

describe("saved food deletion", () => {
  it("checks usage and confirms deletion of an unused food", async () => {
    const date = localDateString();
    const apple: FoodFixture = {
      id: "apple-id", name: "Apple", icon: "pic:apple", basisAmount: 100, unit: "g", source: null,
      calories: 52, protein: 0.3, fat: 0.2, carbs: 14,
      };
    const withApple = {
      day: { date, entries: [], totals: { calories: 0, protein: 0, fat: 0, carbs: 0 } },
      targets: { calories: null, protein: null, fat: null, carbs: null },
      foods: [apple]
    };
    const withoutApple = { ...withApple, foods: [] };
    await seed(withApple);
    const deleteFood = vi.spyOn(repository, "deleteFood");
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Add food to Breakfast" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Apple" }));

    expect(deleteFood).not.toHaveBeenCalled();
    expect(await screen.findByText("This food is not used in any log entries.")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete food" }));

    await waitFor(() => expect(deleteFood).toHaveBeenCalledWith("apple-id"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Delete Apple" })).toBeNull());
  });

  it("states the referenced entry count and deletes the food and entries only after confirmation", async () => {
    const date = localDateString();
    const apple: FoodFixture = {
      id: "apple-id", name: "Apple", icon: "pic:apple", basisAmount: 100, unit: "g", source: null,
      calories: 52, protein: 0.3, fat: 0.2, carbs: 14,
      };
    const loggedApple = { ...entry("apple-entry", "Apple", "breakfast", 0), foodId: apple.id };
    const secondApple = { ...entry("apple-entry-2", "Apple", "lunch", 1), foodId: apple.id };
    const initial = {
      day: { date, entries: [loggedApple, secondApple], totals: { calories: 200, protein: 10, fat: 4, carbs: 30 } },
      targets: { calories: null, protein: null, fat: null, carbs: null }, foods: [apple]
    };
    const emptied = {
      ...initial, day: { date, entries: [], totals: { calories: 0, protein: 0, fat: 0, carbs: 0 } }, foods: []
    };
    await seed(initial);
    const deleteFood = vi.spyOn(repository, "deleteFood");
    render(<App />);

    fireEvent.click((await screen.findAllByRole("button", { name: "Edit Apple" }))[0]);
    const editor = screen.getByRole("dialog", { name: "Edit entry" });
    fireEvent.click(within(editor).getByRole("button", { name: "Delete Apple" }));
    expect(await screen.findByText("This food is used in 2 log entries. Deleting it will also permanently delete all 2 entries.")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(deleteFood).not.toHaveBeenCalled();
    fireEvent.click(within(editor).getByRole("button", { name: "Delete Apple" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete food and 2 entries" }));

    await waitFor(() => expect(deleteFood).toHaveBeenCalledWith("apple-id"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit entry" })).toBeNull());
    // The cascade is applied locally, so both referenced entries leave the day immediately.
    expect(screen.queryAllByRole("button", { name: "Edit Apple" })).toHaveLength(0);
  });
});

describe("resetting app data", () => {
  it("says what will be lost, and only resets once confirmed", async () => {
    const date = localDateString();
    const food: FoodFixture = {
      id: "apple-id", name: "Apple", icon: "pic:apple", basisAmount: 100, unit: "g", source: null,
      calories: 52, protein: 0.3, fat: 0.2, carbs: 14,
    };
    await seed({
      day: { date, entries: [], totals: { calories: 0, protein: 0, fat: 0, carbs: 0 } },
      targets: { calories: null, protein: null, fat: null, carbs: null },
      foods: [food]
    });
    const resetData = vi.spyOn(repository, "resetData").mockResolvedValue();
    vi.spyOn(repository, "dataSummary").mockReturnValue({ foodCount: 1, entryCount: 3 });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Open settings" }));
    fireEvent.click(screen.getByRole("button", { name: /Reset app data/ }));

    expect(await screen.findByText(/3 log entries/)).not.toBeNull();
    expect(screen.getByText(/1 saved food/)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(resetData).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    fireEvent.click(screen.getByRole("button", { name: /Reset app data/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete and restore defaults" }));
    await waitFor(() => expect(resetData).toHaveBeenCalledTimes(1));
  });
});

describe("saved food pictures", () => {
  it("shows the complete catalogue when blank and lets an edited food choose a search result", async () => {
    const date = localDateString();
    const apple: FoodFixture = {
      id: "apple-id", name: "Apple", icon: "pic:apple", basisAmount: 100, unit: "g", source: null,
      calories: 52, protein: 0.3, fat: 0.2, carbs: 14,
      };
    const fixture = {
      day: { date, entries: [], totals: { calories: 0, protein: 0, fat: 0, carbs: 0 } },
      targets: { calories: null, protein: null, fat: null, carbs: null },
      foods: [apple]
    };
    await seed(fixture);
    const saveFood = vi.spyOn(repository, "saveFood").mockResolvedValue({ oneOff: false, ...apple, icon: "pic:apple", ...syncFields() });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Add food to Breakfast" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Apple" }));

    fireEvent.click(screen.getByRole("button", { name: "Change food picture" }));
    expect(await screen.findByText(`All ${foodVisualCatalog.length} approved pictures`)).not.toBeNull();
    const picker = screen.getByRole("dialog", { name: "Choose picture" });
    expect(within(picker).getByRole("button", { name: "Use default picture" })).not.toBeNull();
    await waitFor(() => expect(within(picker).getAllByRole("button", { name: /^Choose .+ picture$/ })).toHaveLength(foodVisualCatalog.length - 1));
    expect(screen.getAllByRole("button", { name: /^Close/ })).toHaveLength(1);
    expect(within(picker).queryByRole("button", { name: "Back" })).toBeNull();
    fireEvent.click(within(picker).getByRole("button", { name: "Close picture chooser" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Change food picture" })));
    fireEvent.click(screen.getByRole("button", { name: "Change food picture" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use default picture" }));
    expect(screen.queryByRole("dialog", { name: "Choose picture" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Change food picture" }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose Apple picture" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(saveFood).toHaveBeenCalledWith(expect.objectContaining({ icon: "pic:apple" }), "apple-id"));
  });

  it("refreshes entries from the saved food without patching a nutrition snapshot", async () => {
    const date = localDateString();
    const granola: FoodFixture = {
      id: "granola-food", name: "Granola", icon: "pic:cereal", basisAmount: 100, unit: "g", source: null,
      calories: 429, protein: 10.1, fat: 10.4, carbs: 67.3
    };
    const loggedGranola: LogEntry = {
      id: "granola-entry", foodId: granola.id, date, name: granola.name, icon: granola.icon,
      amount: 75, basisAmount: granola.basisAmount, unit: granola.unit,
      calories: 321.75, protein: 7.575, fat: 7.8, carbs: 50.475,
      sortIndex: 0, meal: "snack", createdAt: "2026-08-15T00:00:00.000Z", editedAt: "2026-08-15T00:00:00.000Z"
    };
    const updatedName = "Homemade granola";
    await seed({
      day: { entries: [loggedGranola] },
      targets: { calories: null, protein: null, fat: null, carbs: null }, foods: [granola]
    });
    const saveFood = vi.spyOn(repository, "saveFood");
    const updateEntry = vi.spyOn(repository, "updateEntry");
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit Granola" }));
    const editor = screen.getByRole("dialog", { name: "Edit entry" });
    // Editing an existing entry has no "back" -- there is no earlier step to return to.
    expect(within(editor).queryByRole("button", { name: "Choose a different food" })).toBeNull();
    expect(within(editor).queryByText(/^Nutrition per /)).toBeNull();
    fireEvent.click(within(editor).getByRole("button", { name: "Edit selected food" }));
    fireEvent.change(screen.getByLabelText("Food name"), { target: { value: updatedName } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(saveFood).toHaveBeenCalled());
    expect(updateEntry).not.toHaveBeenCalled();
    expect((within(editor).getByRole("spinbutton") as HTMLInputElement).value).toBe("75");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(await screen.findByRole("button", { name: `Edit ${updatedName}` })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Edit Granola" })).toBeNull();
  });
});

describe("calorie log design", () => {
  it("shows the logged day and stays writable with no server involved", async () => {
    await seed({ day: { entries: [entry("oats", "Oats", "breakfast", 0)] } });
    render(<App />);

    expect(await screen.findByText("Oats")).not.toBeNull();
    // Nothing in the day view depends on a request having succeeded.
    expect(screen.getByRole("button", { name: "Add food to Breakfast" })).not.toBeNull();
    expect(screen.getByRole("button", { name: /Open sync details/ })).not.toBeNull();
  });

  it("calculates an energy target from the three macro targets", async () => {
    const fixture = {
      day: { date: localDateString(), entries: [], totals: { calories: 0, protein: 0, fat: 0, carbs: 0 } },
      targets: { calories: null, protein: null, fat: null, carbs: null }, foods: []
    };
    await seed(fixture);
    const saveTargets = vi.spyOn(repository, "saveTargets");
    render(<App />);

    await screen.findByRole("button", { name: "Add food to Breakfast" });
    fireEvent.click(screen.getByRole("button", { name: /Edit nutrition targets; Energy/ }));
    const inputs = screen.getAllByRole("spinbutton") as HTMLInputElement[];
    expect(inputs.every((input) => input.type === "search" && input.classList.contains("android-input-workaround"))).toBe(true);
    fireEvent.change(inputs[1], { target: { value: "120" } });
    fireEvent.change(inputs[2], { target: { value: "60" } });
    fireEvent.change(inputs[3], { target: { value: "200" } });

    expect(inputs[0].value).toBe("1820");
    fireEvent.click(screen.getByRole("button", { name: "Save targets" }));
    await waitFor(() => expect(saveTargets).toHaveBeenCalledWith({ calories: 1820, protein: 120, fat: 60, carbs: 200 }));
  });

  it("offers a left-side home control on another date without overlapping navigation", async () => {
    const date = localDateString();
    const fixture = {
      day: { date, entries: [], totals: { calories: 0, protein: 0, fat: 0, carbs: 0 } },
      targets: { calories: null, protein: null, fat: null, carbs: null }, foods: []
    };
    await seed(fixture);
    render(<App />);

    await screen.findByRole("button", { name: "Add food to Breakfast" });
    expect(screen.queryByRole("button", { name: "Go to today" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next day" }));

    const home = await screen.findByRole("button", { name: "Go to today" });
    expect(home.querySelector("svg")).not.toBeNull();
    expect(screen.queryByText("Today")).toBeNull();
    fireEvent.click(home);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Go to today" })).toBeNull());
  });

  it("repeats only the requested meal and confirms deletion inside the interface", async () => {
    const breakfast = entry("breakfast-entry", "Oats", "breakfast", 0);
    const fixture = {
      day: { date: localDateString(), entries: [breakfast], totals: { calories: 100, protein: 5, fat: 2, carbs: 15 } },
      targets: { calories: null, protein: null, fat: null, carbs: null }, foods: []
    };
    await seed(fixture);
    const repeat = vi.spyOn(repository, "repeatPreviousMeal");
    const deleteEntries = vi.spyOn(repository, "deleteEntries");
    render(<App />);

    await screen.findByText("Oats");
    const breakfastSection = screen.getByRole("heading", { name: "Breakfast" }).closest("section")!;
    fireEvent.click(within(breakfastSection).getByRole("button", { name: "Repeat yesterday's Breakfast" }));
    await waitFor(() => expect(repeat).toHaveBeenCalledWith(localDateString(), "breakfast"));

    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    fireEvent.click(screen.getByRole("button", { name: /Select entries/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Oats" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(deleteEntries).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteEntries).toHaveBeenCalledWith(["breakfast-entry"]));
  });

  it("can drag an entry into the first position with a visible insertion target", async () => {
    const first = entry("first", "First food", "breakfast", 0);
    const second = entry("second", "Second food", "breakfast", 1);
    const day = { date: localDateString(), entries: [first, second], totals: { calories: 200, protein: 10, fat: 4, carbs: 30 } };
    await seed({
 day, targets: { calories: null, protein: null, fat: null, carbs: null }, foods: [] });
    const reorder = vi.spyOn(repository, "reorderEntries");
    render(<App />);
    await screen.findByText("First food");

    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    fireEvent.click(screen.getByRole("button", { name: /Reorder entries/ }));
    const targetRow = screen.getByRole("button", { name: "Reorder First food" }).closest<HTMLElement>("[role=row]")!;
    targetRow.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 500, bottom: 60, width: 500, height: 60, toJSON: () => ({}) });
    const data = new Map<string, string>();
    const dataTransfer = { effectAllowed: "move", setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? "" };
    const sourceRow = screen.getByRole("button", { name: "Reorder Second food" }).closest<HTMLElement>("[role=row]")!;
    fireEvent.dragStart(sourceRow, { dataTransfer });
    fireEvent.dragOver(targetRow, { clientX: 20, clientY: 5, dataTransfer });
    const activeTargetRow = screen.getByRole("button", { name: "Reorder First food" }).closest<HTMLElement>("[role=row]")!;
    expect(activeTargetRow.className).toContain("drop-before");
    fireEvent.drop(activeTargetRow, { clientX: 20, clientY: 5, dataTransfer });

    await waitFor(() => expect(reorder).toHaveBeenCalledWith([
      { id: "second", meal: "breakfast" }, { id: "first", meal: "breakfast" }
    ]));
  });

  it("keeps each entry on one readable row with meal actions beside its name and aligned nutrition", async () => {
    const apple = entry("apple", "A very long apple name that should truncate", "dinner", 0);
    await seed({
      day: { date: localDateString(), entries: [apple], totals: { calories: 100, protein: 5, fat: 2, carbs: 15 } },
      targets: { calories: null, protein: null, fat: null, carbs: null }, foods: []
    });
    render(<App />);

    const rowButton = await screen.findByRole("button", { name: `Edit ${apple.name}` });
    const row = rowButton.closest<HTMLElement>("[role=row]")!;
    expect(row.querySelectorAll(".food-entry-main")).toHaveLength(1);
    expect(row.querySelector("input[type=checkbox]")).toBeNull();
    expect(Array.from(rowButton.children).slice(1).map((cell) => cell.textContent)).toEqual(["100.0", "5.0", "2.0", "15.0", "100"]);
    const dinnerSection = screen.getByRole("heading", { name: "Dinner" }).closest("section")!;
    // The heading's grid moved onto an inner element when a selection checkbox column was added
    // beside it, and the columns it aligns with the rows are the same ones.
    const dinnerHeading = dinnerSection.querySelector(".meal-heading-main")!;
    expect(dinnerHeading.children).toHaveLength(5);
    expect(dinnerHeading.children[0].className).toBe("meal-primary");
    expect(dinnerHeading.children[0].querySelector(".meal-actions")).not.toBeNull();
    expect(dinnerHeading.children[0].querySelectorAll("svg")).toHaveLength(3);
    expect(Array.from(dinnerHeading.children[0].querySelectorAll(".meal-repeat path")).map((path) => path.getAttribute("d"))).toEqual([
      "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8",
      "M3 3v5h5",
      "M12 7v5l4 2"
    ]);
    expect(dinnerHeading.children[1].getAttribute("aria-label")).toBe("Protein 5.0 grams");
    expect(dinnerHeading.children[2].getAttribute("aria-label")).toBe("Fat 2.0 grams");
    expect(dinnerHeading.children[3].getAttribute("aria-label")).toBe("Carbohydrates 15.0 grams");
    expect(dinnerHeading.children[4].getAttribute("aria-label")).toBe("Energy 100 kilocalories");
    expect(screen.queryByText("1 item")).toBeNull();
    expect(screen.getAllByRole("button", { name: /Add food to/ })).toHaveLength(4);
  });

  it("collapses and expands each meal independently", async () => {
    const oats = entry("oats", "Oats", "breakfast", 0);
    await seed({
      day: { date: localDateString(), entries: [oats], totals: { calories: 100, protein: 5, fat: 2, carbs: 15 } },
      targets: { calories: null, protein: null, fat: null, carbs: null }, foods: []
    });
    render(<App />);

    await screen.findByRole("button", { name: "Edit Oats" });
    const breakfastToggle = screen.getByRole("button", { name: "Breakfast" });
    expect(breakfastToggle.getAttribute("aria-expanded")).toBe("true");
    const expandedIconPath = breakfastToggle.querySelector("svg path")?.getAttribute("d");

    fireEvent.click(breakfastToggle);
    expect(breakfastToggle.getAttribute("aria-expanded")).toBe("false");
    expect(breakfastToggle.querySelector("svg path")?.getAttribute("d")).not.toBe(expandedIconPath);
    expect(screen.queryByRole("button", { name: "Edit Oats" })).toBeNull();

    fireEvent.click(breakfastToggle);
    expect(breakfastToggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Edit Oats" })).not.toBeNull();
  });

  it("uses the web page origin automatically when signing in outside the native host", async () => {
    vi.spyOn(backendSession, "restore").mockResolvedValue(null);
    const login = vi.spyOn(backendSession, "login").mockResolvedValue({ baseUrl: window.location.origin, email: "person@example.test", token: "token", userId: "test-owner" });
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Sign in" })).not.toBeNull();
    expect(screen.queryByLabelText("Server URL")).toBeNull();
    expect(screen.getByLabelText("Email").getAttribute("type")).toBe("email");
    expect(screen.getByLabelText("Password").getAttribute("type")).toBe("password");
    expect(screen.getByLabelText("Email").getAttribute("autocomplete")).toBe("username");
    expect(screen.getByLabelText("Password").getAttribute("autocomplete")).toBe("current-password");
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "person@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "temporary" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(login).toHaveBeenCalledWith(window.location.origin, "person@example.test", "temporary"));
  });

  it("offers installation before sign-in in an Android browser", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Linux; Android 15)", platform: "Linux armv8l", maxTouchPoints: 5 });
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Install the app" })).not.toBeNull();
    // Chrome hides its install event once the app is installed, so the page must explain both
    // states rather than silently losing the button and reading as broken.
    expect(screen.getByText(/it offers Install app when Calorie Logger is not installed yet, and Open app when it already is/i)).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Sign in" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue in browser" }));
    expect(await screen.findByRole("button", { name: "Add food to Breakfast" })).not.toBeNull();
  });
});

describe("high-contribution foods", () => {
  const TARGETS = { calories: 1820, protein: 120, fat: 60, carbs: 200 };

  function helping(id: string, foodId: string, name: string, sortIndex: number, macros: { fat: number; carbs: number }, amount = 100): LogEntry {
    return {
      id, foodId, date: localDateString(), name, icon: "pic:apple", amount, basisAmount: amount,
      unit: "g", calories: 0, protein: 0, ...macros, sortIndex, meal: "breakfast",
      createdAt: "2026-08-15T00:00:00.000Z", editedAt: "2026-08-15T00:00:00.000Z"
    };
  }

  const bananas = [0, 1, 2].map((index) => helping(`banana-${index}`, "banana", "Banana", index, { fat: 0.4, carbs: 27 }, 118));
  const oliveOil = helping("olive-oil-0", "olive-oil", "Olive oil", 3, { fat: 14, carbs: 0 }, 14);

  const cells = (button: HTMLElement) => Array.from(button.children) as HTMLElement[];

  it("weighs a food by its whole day, so repeated helpings stop hiding behind one another", async () => {
    await seed({
      day: { date: localDateString(), entries: bananas, totals: {} },
      targets: TARGETS, foods: []
    });
    render(<App />);

    // 27g of carbohydrate a time is unremarkable; 81g against a 200g target is not, and every row of
    // the food says so, which is the whole point of judging the food rather than the helping.
    const rows = await screen.findAllByRole("button", { name: /^Edit Banana/ });
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(cells(row)[4].className).toBe("share-2");
      expect(cells(row)[4].getAttribute("title")).toBe("Banana ×3 — 41% of the carbohydrate target today");
      expect(cells(row)[4].textContent).toBe("27.0");
      // Fat is nowhere near its target, and protein is never flagged at all.
      expect(cells(row)[3].className).toBe("");
      expect(cells(row)[2].className).toBe("");
    }
  });

  it("flags a single heavy portion on its own, without counting a helping it does not have", async () => {
    await seed({
      day: { date: localDateString(), entries: [bananas[0], oliveOil], totals: {} },
      targets: TARGETS, foods: []
    });
    render(<App />);

    const oil = await screen.findByRole("button", { name: /^Edit Olive oil/ });
    expect(cells(oil)[3].className).toBe("share-1");
    expect(cells(oil)[3].getAttribute("title")).toBe("Olive oil — 23% of the fat target today");
    // One banana is 14% of the carbohydrate target and stays quiet.
    const banana = screen.getByRole("button", { name: /^Edit Banana/ });
    expect(cells(banana)[4].className).toBe("");
  });

  it("says why a row stands out, for a reader who cannot see the tint", async () => {
    await seed({
      day: { date: localDateString(), entries: [...bananas, oliveOil], totals: {} },
      targets: TARGETS, foods: []
    });
    render(<App />);

    await screen.findAllByRole("button", { name: "Edit Banana, carbohydrate 41 percent of target" });
    screen.getByRole("button", { name: "Edit Olive oil, fat 23 percent of target" });
  });

  it("flags nothing without a target to measure against", async () => {
    await seed({
      day: { date: localDateString(), entries: bananas, totals: {} },
      targets: { calories: null, protein: null, fat: null, carbs: null }, foods: []
    });
    render(<App />);

    const rows = await screen.findAllByRole("button", { name: /^Edit Banana/ });
    expect(rows.map((row) => cells(row)[4].className)).toEqual(["", "", ""]);
  });

  it("flags nothing once the owner turns the tinting off", async () => {
    await seed({
      day: { date: localDateString(), entries: bananas, totals: {} },
      targets: TARGETS, foods: [], contributionThreshold: 0
    });
    render(<App />);

    const rows = await screen.findAllByRole("button", { name: /^Edit Banana/ });
    expect(rows.map((row) => cells(row)[4].className)).toEqual(["", "", ""]);
  });

  it("saves a changed threshold alongside the day rollover", async () => {
    await seed({ day: { date: localDateString(), entries: [], totals: {} }, targets: TARGETS, foods: [] });
    const savePreferences = vi.spyOn(repository, "savePreferences");
    render(<App />);

    await screen.findByRole("button", { name: "Add food to Breakfast" });
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    fireEvent.click(screen.getByRole("button", { name: /Preferences/ }));
    const threshold = screen.getByRole("spinbutton") as HTMLInputElement;
    expect(threshold.value).toBe("20");
    fireEvent.change(threshold, { target: { value: "35" } });
    fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));

    await waitFor(() => expect(savePreferences).toHaveBeenCalledWith({ dayRolloverMinutes: 0, contributionThreshold: 35 }));
  });
});

describe("entry gestures and bulk actions", () => {
  const NO_TARGETS: Targets = { calories: null, protein: null, fat: null, carbs: null };

  // jsdom has no PointerEvent, and its stand-in drops every field the gestures read. This is the
  // smallest thing that carries a pointer type, a button and a position.
  class TestPointerEvent extends MouseEvent {
    pointerType: string;
    pointerId: number;
    constructor(type: string, init: MouseEventInit & { pointerType?: string; pointerId?: number } = {}) {
      super(type, init);
      this.pointerType = init.pointerType ?? "mouse";
      this.pointerId = init.pointerId ?? 1;
    }
  }
  beforeEach(() => { vi.stubGlobal("PointerEvent", TestPointerEvent); });

  async function day(entries: LogEntry[]) {
    await seed({ day: { date: localDateString(), entries, totals: {} }, targets: NO_TARGETS, foods: [] });
  }
  const rowOf = (name: string) => screen.getByRole("button", { name: `Edit ${name}` }).closest<HTMLElement>("[role=row]")!;
  const touch = { pointerType: "touch", pointerId: 1, button: 0 };

  it("lifts an entry for reordering after a still press", async () => {
    await day([entry("a", "Oats", "breakfast", 0)]);
    render(<App />);
    await screen.findByText("Oats");
    const row = rowOf("Oats");

    vi.useFakeTimers();
    fireEvent.pointerDown(row, { ...touch, clientX: 40, clientY: 40 });
    act(() => { vi.advanceTimersByTime(400); });
    vi.useRealTimers();

    expect(screen.getByText("Drag entries into place")).toBeTruthy();
    const lifted = screen.getByRole("button", { name: "Reorder Oats" }).closest<HTMLElement>("[role=row]")!;
    expect(lifted.className).toContain("is-dragged");
  });

  it("treats a press that moves before it settles as a scroll, and lifts nothing", async () => {
    await day([entry("a", "Oats", "breakfast", 0)]);
    render(<App />);
    await screen.findByText("Oats");

    vi.useFakeTimers();
    fireEvent.pointerDown(rowOf("Oats"), { ...touch, clientX: 40, clientY: 40 });
    fireEvent.pointerMove(document, { ...touch, clientX: 42, clientY: 90 });
    act(() => { vi.advanceTimersByTime(400); });
    vi.useRealTimers();

    expect(screen.queryByText("Drag entries into place")).toBeNull();
  });

  it("opens the editor on a quick tap", async () => {
    await day([entry("a", "Oats", "breakfast", 0)]);
    render(<App />);
    await screen.findByText("Oats");

    fireEvent.pointerDown(rowOf("Oats"), { ...touch, clientX: 40, clientY: 40 });
    fireEvent.pointerUp(document, { ...touch, clientX: 40, clientY: 40 });
    fireEvent.click(screen.getByRole("button", { name: "Edit Oats" }));

    expect(await screen.findByRole("dialog", { name: "Edit entry" })).toBeTruthy();
  });

  it("leaves selection mode once the selected entries are deleted", async () => {
    await day([entry("a", "Oats", "breakfast", 0)]);
    const deleteEntries = vi.spyOn(repository, "deleteEntries");
    render(<App />);
    await screen.findByText("Oats");

    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    fireEvent.click(screen.getByRole("button", { name: /Select entries/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Oats" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleteEntries).toHaveBeenCalledWith(["a"]));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Done" })).toBeNull());
    expect(screen.queryByRole("checkbox", { name: "Select Oats" })).toBeNull();
  });

  it("selects and clears a whole meal from its heading", async () => {
    await day([entry("a", "Oats", "breakfast", 0), entry("b", "Toast", "breakfast", 1), entry("c", "Soup", "lunch", 2)]);
    render(<App />);
    await screen.findByText("Oats");

    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    fireEvent.click(screen.getByRole("button", { name: /Select entries/ }));
    const wholeMeal = screen.getByRole("checkbox", { name: "Select all Breakfast" }) as HTMLInputElement;
    fireEvent.click(wholeMeal);

    expect(screen.getByText("2 selected")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "Select Soup" }) as HTMLInputElement).checked).toBe(false);
    expect(wholeMeal.checked).toBe(true);

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Oats" }));
    expect((screen.getByRole("checkbox", { name: "Select all Breakfast" }) as HTMLInputElement).indeterminate).toBe(true);

    // Clicking a partly filled box takes the rest of the meal, and clicking it again lets it all go.
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all Breakfast" }));
    expect(screen.getByText("2 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all Breakfast" }));
    expect(screen.getByText("Tap entries to select")).toBeTruthy();
  });

  it("copies the selection into a chosen day and meal, and closes the selection", async () => {
    await day([entry("a", "Oats", "breakfast", 0)]);
    const copyEntries = vi.spyOn(repository, "copyEntries");
    render(<App />);
    await screen.findByText("Oats");

    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    fireEvent.click(screen.getByRole("button", { name: /Select entries/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Oats" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy…" }));

    fireEvent.click(screen.getByRole("button", { name: "Tomorrow" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Meal" }), { target: { value: "dinner" } });
    fireEvent.click(screen.getByRole("button", { name: "Copy 1 entry" }));

    await waitFor(() => expect(copyEntries).toHaveBeenCalledWith(["a"], moveDate(localDateString(), 1), "dinner"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("checkbox", { name: "Select Oats" })).toBeNull();
  });

  it("moves the selection instead of copying it, keeping the original meals", async () => {
    await day([entry("a", "Oats", "breakfast", 0)]);
    const moveEntries = vi.spyOn(repository, "moveEntries");
    render(<App />);
    await screen.findByText("Oats");

    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    fireEvent.click(screen.getByRole("button", { name: /Select entries/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Oats" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy…" }));
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    fireEvent.click(screen.getByRole("button", { name: "Move 1 entry" }));

    await waitFor(() => expect(moveEntries).toHaveBeenCalledWith(["a"], moveDate(localDateString(), 1), undefined));
  });

  it("reveals copy and delete under a swiped entry, and puts them away on a scroll", async () => {
    await day([entry("a", "Oats", "breakfast", 0)]);
    render(<App />);
    await screen.findByText("Oats");

    fireEvent.pointerDown(rowOf("Oats"), { ...touch, clientX: 260, clientY: 40 });
    fireEvent.pointerMove(document, { ...touch, clientX: 220, clientY: 42 });
    fireEvent.pointerUp(document, { ...touch, clientX: 160, clientY: 42 });

    expect(screen.getByRole("button", { name: "Copy…" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();

    fireEvent.scroll(window);
    expect(screen.queryByRole("button", { name: "Copy…" })).toBeNull();
  });

  it("offers the entry actions on a right-click and duplicates into the same meal", async () => {
    await day([entry("a", "Oats", "breakfast", 0)]);
    const copyEntries = vi.spyOn(repository, "copyEntries");
    render(<App />);
    await screen.findByText("Oats");

    fireEvent.contextMenu(rowOf("Oats"), { clientX: 120, clientY: 200 });
    expect(screen.getByRole("menu", { name: "Oats" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate here" }));

    await waitFor(() => expect(copyEntries).toHaveBeenCalledWith(["a"], localDateString(), "breakfast"));
  });

  it("confirms before deleting one entry from its own actions", async () => {
    await day([entry("a", "Oats", "breakfast", 0)]);
    const deleteEntries = vi.spyOn(repository, "deleteEntries");
    render(<App />);
    await screen.findByText("Oats");

    fireEvent.contextMenu(rowOf("Oats"), { clientX: 120, clientY: 200 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(deleteEntries).not.toHaveBeenCalled();

    fireEvent.click(within(screen.getByRole("dialog", { name: "Delete entry" })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteEntries).toHaveBeenCalledWith(["a"]));
  });

  it("moves a focused entry between positions and meals with the arrow keys", async () => {
    await day([entry("a", "Oats", "breakfast", 0), entry("b", "Toast", "breakfast", 1)]);
    const reorder = vi.spyOn(repository, "reorderEntries");
    render(<App />);
    await screen.findByText("Oats");

    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    fireEvent.click(screen.getByRole("button", { name: /Reorder entries/ }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Reorder Oats" }), { key: "ArrowDown" });

    await waitFor(() => expect(reorder).toHaveBeenCalledWith([
      { id: "b", meal: "breakfast" }, { id: "a", meal: "breakfast" }
    ]));
  });
});
