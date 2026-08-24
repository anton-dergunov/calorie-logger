import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localDateString, moveDate } from "./date";
import { defaultCatalog } from "./defaultCatalog";
import { localStore } from "./localStore";
import type { Food, FoodInput, StoredEntry, SyncFields } from "./types";
import { DEFAULT_CONTRIBUTION_THRESHOLD } from "./types";

const TODAY = localDateString();
const YESTERDAY = moveDate(TODAY, -1);

function syncFields(editedAt: string, editedBy = "remotedevice001"): SyncFields {
  return { deleted: false, createdAt: editedAt, editedAt, editedBy, revision: 1 };
}

function foodInput(overrides: Partial<FoodInput> = {}): FoodInput {
  return {
    name: "Oats", icon: "pic:cereal", basisAmount: 100, unit: "g", source: null, oneOff: false,
    calories: 370, protein: 13, fat: 7, carbs: 62, ...overrides
  };
}

function remoteFood(id: string, name: string, editedAt = "2026-08-15T00:00:00.000Z"): Food {
  return { ...foodInput({ name }), id, ...syncFields(editedAt) };
}

function remoteEntry(id: string, foodId: string, date: string, sortIndex: number, amount = 100): StoredEntry {
  return { id, foodId, date, meal: "breakfast", sortIndex, amount, ...syncFields("2026-08-15T00:00:00.000Z") };
}

beforeEach(async () => {
  await localStore.clear();
  await localStore.load("owner-1");
});

afterEach(async () => { await localStore.clear(); });

describe("day assembly", () => {
  it("derives every entry from the current saved food and totals the unrounded values", async () => {
    const food = await localStore.saveFood(foodInput({ basisAmount: 100, calories: 429, protein: 10.1, fat: 10.4, carbs: 67.3 }));
    await localStore.addEntry(TODAY, food.id, 75, "snack");

    const day = localStore.day(TODAY);
    expect(day.entries).toHaveLength(1);
    expect(day.entries[0]).toMatchObject({ name: "Oats", amount: 75, unit: "g", meal: "snack" });
    expect(day.entries[0].calories).toBeCloseTo(321.75, 6);
    expect(day.totals.protein).toBeCloseTo(7.575, 6);
  });

  it("follows an edit of the saved food without storing a nutrition snapshot on the entry", async () => {
    const food = await localStore.saveFood(foodInput());
    await localStore.addEntry(TODAY, food.id, 100, "breakfast");
    await localStore.saveFood(foodInput({ name: "Jumbo oats", calories: 400 }), food.id);

    expect(localStore.day(TODAY).entries[0]).toMatchObject({ name: "Jumbo oats", calories: 400 });
  });

  it("keeps only the requested day and orders entries by their position", async () => {
    const food = await localStore.saveFood(foodInput());
    await localStore.addEntry(YESTERDAY, food.id, 10, "breakfast");
    await localStore.addEntry(TODAY, food.id, 20, "breakfast");
    await localStore.addEntry(TODAY, food.id, 30, "breakfast");

    expect(localStore.day(TODAY).entries.map((item) => item.amount)).toEqual([20, 30]);
    expect(localStore.day(YESTERDAY).entries.map((item) => item.amount)).toEqual([10]);
  });
});

describe("food catalogue", () => {
  it("ranks recently used foods first and unused foods by name", async () => {
    const pear = await localStore.saveFood(foodInput({ name: "Pear" }));
    await localStore.saveFood(foodInput({ name: "Almonds" }));
    const oats = await localStore.saveFood(foodInput({ name: "Oats" }));
    await localStore.addEntry(TODAY, pear.id, 100, "breakfast");
    await localStore.addEntry(TODAY, oats.id, 100, "lunch");

    expect(localStore.getSnapshot().foods.map((food) => food.name)).toEqual(["Oats", "Pear", "Almonds"]);
  });

  it("finds an already-saved external food so a repeat scan reuses it", async () => {
    const source = { provider: "openFoodFacts" as const, id: "5012345678900", label: "Open Food Facts", url: "https://example.test" };
    const saved = await localStore.saveFood(foodInput({ name: "Oat bar", source }));

    expect(localStore.foodBySource("openFoodFacts", "5012345678900")?.id).toBe(saved.id);
    expect(localStore.foodBySource("openFoodFacts", "0000000000000")).toBeNull();
  });

  it("reports the amount last logged, so the same food can be offered it again", async () => {
    const food = await localStore.saveFood(foodInput());
    const never = await localStore.saveFood(foodInput({ name: "Pear" }));
    expect(localStore.foodUsage(food.id)).toEqual({ entryCount: 0, lastAmount: null });

    await localStore.addEntry(TODAY, food.id, 100, "breakfast");
    await localStore.addEntry(YESTERDAY, food.id, 250, "lunch");

    // The most recently written entry, not the one on the latest date: what matters is the
    // amount this person reached for last.
    expect(localStore.foodUsage(food.id)).toEqual({ entryCount: 2, lastAmount: 250 });
    expect(localStore.foodUsage(never.id).lastAmount).toBeNull();

    // A tombstoned entry is not a memory of anything.
    const logged = localStore.day(YESTERDAY).entries.map((item) => item.id);
    await localStore.deleteEntries(logged);
    expect(localStore.foodUsage(food.id)).toEqual({ entryCount: 1, lastAmount: 100 });
  });

  it("deletes every entry that uses a deleted food", async () => {
    const food = await localStore.saveFood(foodInput());
    const other = await localStore.saveFood(foodInput({ name: "Pear" }));
    await localStore.addEntry(TODAY, food.id, 100, "breakfast");
    await localStore.addEntry(YESTERDAY, food.id, 50, "lunch");
    await localStore.addEntry(TODAY, other.id, 25, "snack");
    expect(localStore.foodUsage(food.id)).toEqual({ entryCount: 2, lastAmount: 50 });

    await localStore.deleteFood(food.id);

    expect(localStore.day(TODAY).entries.map((item) => item.name)).toEqual(["Pear"]);
    expect(localStore.day(YESTERDAY).entries).toHaveLength(0);
    expect(localStore.getSnapshot().foods.map((item) => item.name)).toEqual(["Pear"]);
  });
});

describe("entry operations", () => {
  it("reorders across meals and copies, repeats, and deletes entries", async () => {
    const food = await localStore.saveFood(foodInput());
    await localStore.addEntry(TODAY, food.id, 10, "breakfast");
    await localStore.addEntry(TODAY, food.id, 20, "breakfast");
    const [first, second] = localStore.day(TODAY).entries;

    await localStore.reorderEntries([{ id: second.id, meal: "lunch" }, { id: first.id, meal: "breakfast" }]);
    const reordered = localStore.day(TODAY).entries;
    expect(reordered.map((item) => [item.amount, item.meal])).toEqual([[20, "lunch"], [10, "breakfast"]]);

    await localStore.copyEntries([first.id], moveDate(TODAY, 1));
    expect(localStore.day(moveDate(TODAY, 1)).entries.map((item) => item.amount)).toEqual([10]);

    await localStore.deleteEntries([first.id]);
    expect(localStore.day(TODAY).entries.map((item) => item.amount)).toEqual([20]);
    // The copy is an independent entry and survives deletion of the entry it came from.
    expect(localStore.day(moveDate(TODAY, 1)).entries).toHaveLength(1);
  });

  it("repeats only the requested meal from the previous day", async () => {
    const food = await localStore.saveFood(foodInput());
    await localStore.addEntry(YESTERDAY, food.id, 10, "breakfast");
    await localStore.addEntry(YESTERDAY, food.id, 20, "dinner");

    await localStore.repeatPreviousMeal(TODAY, "breakfast");

    expect(localStore.day(TODAY).entries.map((item) => [item.amount, item.meal])).toEqual([[10, "breakfast"]]);
    expect(localStore.day(YESTERDAY).entries).toHaveLength(2);
  });

  it("copies into a chosen meal, and repeating keeps each entry in its own", async () => {
    const food = await localStore.saveFood(foodInput());
    await localStore.addEntry(YESTERDAY, food.id, 10, "breakfast");
    await localStore.addEntry(YESTERDAY, food.id, 20, "dinner");
    const sources = localStore.day(YESTERDAY).entries.map((item) => item.id);

    await localStore.copyEntries(sources, TODAY, "lunch");
    expect(localStore.day(TODAY).entries.map((item) => [item.amount, item.meal])).toEqual([[10, "lunch"], [20, "lunch"]]);

    await localStore.repeatPreviousMeal(TODAY, "dinner");
    expect(localStore.day(TODAY).entries.map((item) => item.meal)).toEqual(["lunch", "lunch", "dinner"]);
  });

  it("moves entries to another day and meal, keeping the records themselves", async () => {
    const food = await localStore.saveFood(foodInput());
    await localStore.addEntry(TODAY, food.id, 10, "breakfast");
    await localStore.addEntry(TODAY, food.id, 20, "breakfast");
    const [first] = localStore.day(TODAY).entries;

    await localStore.moveEntries([first.id], YESTERDAY, "dinner");

    expect(localStore.day(TODAY).entries.map((item) => item.amount)).toEqual([20]);
    const moved = localStore.day(YESTERDAY).entries;
    expect(moved.map((item) => [item.id, item.amount, item.meal])).toEqual([[first.id, 10, "dinner"]]);
  });

  it("appends repeated and copied entries after whatever the day already holds", async () => {
    const food = await localStore.saveFood(foodInput());
    await localStore.addEntry(YESTERDAY, food.id, 10, "breakfast");
    await localStore.addEntry(TODAY, food.id, 99, "breakfast");

    await localStore.repeatPreviousDay(TODAY);

    expect(localStore.day(TODAY).entries.map((item) => item.amount)).toEqual([99, 10]);
  });
});

describe("one-off foods", () => {
  it("tombstones a one-off once nothing references it, and leaves catalogue foods alone", async () => {
    const oneOff = await localStore.saveFood(foodInput({ name: "Slice of birthday cake", oneOff: true }));
    const catalogue = await localStore.saveFood(foodInput({ name: "Oats" }));
    await localStore.addEntry(TODAY, oneOff.id, 1, "snack");
    await localStore.addEntry(TODAY, catalogue.id, 100, "breakfast");
    const [breakfast, snack] = localStore.day(TODAY).entries;

    await localStore.deleteEntries([breakfast.id]);
    expect(localStore.food(catalogue.id)).not.toBeNull();

    await localStore.deleteEntries([snack.id]);
    expect(localStore.food(oneOff.id)).toBeNull();
  });

  it("keeps a one-off while any copy of its entry still uses it", async () => {
    const oneOff = await localStore.saveFood(foodInput({ name: "Leftover curry", oneOff: true }));
    await localStore.addEntry(YESTERDAY, oneOff.id, 1, "dinner");
    const [yesterday] = localStore.day(YESTERDAY).entries;
    await localStore.copyEntries([yesterday.id], TODAY);
    const [today] = localStore.day(TODAY).entries;

    // Copies share the food, so editing it reaches both days.
    await localStore.saveFood(foodInput({ name: "Leftover curry", oneOff: true, calories: 500 }), oneOff.id);
    expect(localStore.day(TODAY).entries[0].name).toBe("Leftover curry");

    await localStore.deleteEntries([yesterday.id]);
    expect(localStore.food(oneOff.id)).not.toBeNull();

    // A half portion of the leftovers, then nothing left that uses the food.
    await localStore.updateEntry(today.id, TODAY, 0.5, "dinner");
    expect(localStore.day(TODAY).entries[0].amount).toBe(0.5);
    await localStore.deleteEntries([today.id]);
    expect(localStore.food(oneOff.id)).toBeNull();
  });

  it("tombstones a one-off an entry is pointed away from", async () => {
    const oneOff = await localStore.saveFood(foodInput({ name: "Canteen stew", oneOff: true }));
    const catalogue = await localStore.saveFood(foodInput());
    await localStore.addEntry(TODAY, oneOff.id, 1, "lunch");
    const [logged] = localStore.day(TODAY).entries;

    await localStore.updateEntry(logged.id, TODAY, 100, "lunch", catalogue.id);

    expect(localStore.food(oneOff.id)).toBeNull();
    expect(localStore.day(TODAY).entries[0].name).toBe("Oats");
  });
});

describe("targets and export", () => {
  it("stores targets and includes them in an export", async () => {
    const food = await localStore.saveFood(foodInput());
    await localStore.addEntry(TODAY, food.id, 100, "breakfast");
    await localStore.addEntry(moveDate(TODAY, -5), food.id, 50, "lunch");
    await localStore.saveTargets({ calories: 1820, protein: 120, fat: 60, carbs: 200 });

    expect(localStore.getSnapshot().targets).toEqual({ calories: 1820, protein: 120, fat: 60, carbs: 200 });
    const everything = localStore.exportDocument({ scope: "all" });
    expect(everything.entries).toHaveLength(2);
    expect(everything.targets.calories).toBe(1820);

    const ranged = localStore.exportDocument({ scope: "range", startDate: TODAY, endDate: TODAY });
    expect(ranged.entries).toHaveLength(1);
    expect(ranged.foods.map((item) => item.id)).toEqual([food.id]);
  });

  it("keeps the preferences and the targets on one record, so neither write clears the other", async () => {
    await localStore.saveTargets({ calories: 1820, protein: 120, fat: 60, carbs: 200 });
    await localStore.savePreferences({ dayRolloverMinutes: 240, contributionThreshold: 30 });

    expect(localStore.getSnapshot().dayRolloverMinutes).toBe(240);
    expect(localStore.getSnapshot().contributionThreshold).toBe(30);
    expect(localStore.getSnapshot().targets.calories).toBe(1820);

    await localStore.saveTargets({ calories: 2000, protein: 130, fat: 65, carbs: 210 });
    expect(localStore.getSnapshot().contributionThreshold).toBe(30);
    expect(localStore.getSnapshot().dayRolloverMinutes).toBe(240);
  });

  it("carries a changed preference to the owner's other devices", async () => {
    await localStore.savePreferences({ dayRolloverMinutes: 0, contributionThreshold: 0 });
    expect(localStore.getSnapshot().contributionThreshold).toBe(0);
    expect(localStore.pendingChanges().settings?.contributionThreshold).toBe(0);
  });
});

describe("replication", () => {
  it("queues every local change until the server accepts it", async () => {
    const food = await localStore.saveFood(foodInput());
    await localStore.addEntry(TODAY, food.id, 100, "breakfast");
    await localStore.saveTargets({ calories: 2000, protein: null, fat: null, carbs: null });

    const pending = localStore.pendingChanges();
    expect(pending.foods).toHaveLength(1);
    expect(pending.entries).toHaveLength(1);
    expect(pending.settings).not.toBeNull();
    expect(localStore.pendingCount()).toBe(3);

    await localStore.confirmPushed(pending, "2026-08-21T09:00:00.000Z");
    expect(localStore.pendingCount()).toBe(0);
    expect(localStore.syncTimes().lastPushedAt).toBe("2026-08-21T09:00:00.000Z");
  });

  it("keeps a record pending when it is edited again while its push is in flight", async () => {
    const food = await localStore.saveFood(foodInput());
    const inFlight = localStore.pendingChanges();
    await localStore.saveFood(foodInput({ name: "Edited while syncing" }), food.id);

    await localStore.confirmPushed(inFlight, "2026-08-21T09:00:00.000Z");

    expect(localStore.pendingCount()).toBe(1);
    expect(localStore.getSnapshot().foods[0].name).toBe("Edited while syncing");
  });

  it("accepts a newer remote record and reports the local change it replaced", async () => {
    const food = await localStore.saveFood(foodInput({ name: "Local name" }));
    const winner: Food = { ...food, name: "Remote name", editedAt: "2099-01-01T00:00:00.000Z", editedBy: "otherdevice0001", revision: 12 };

    const superseded = await localStore.applyRemote({ foods: [winner], entries: [], settings: null }, 12, "2026-08-21T09:00:00.000Z");

    expect(superseded).toBe(1);
    expect(localStore.getSnapshot().foods[0].name).toBe("Remote name");
    expect(localStore.pendingCount()).toBe(0);
    expect(localStore.cursor()).toBe(12);
  });

  it("keeps a newer local change when an older remote version arrives", async () => {
    const food = await localStore.saveFood(foodInput({ name: "Local name" }));
    const loser: Food = { ...food, name: "Stale name", editedAt: "1999-01-01T00:00:00.000Z", editedBy: "otherdevice0001", revision: 3 };

    const superseded = await localStore.applyRemote({ foods: [loser], entries: [], settings: null }, 3, "2026-08-21T09:00:00.000Z");

    expect(superseded).toBe(0);
    expect(localStore.getSnapshot().foods[0].name).toBe("Local name");
    // The local version is still queued, so the next push carries it to the server.
    expect(localStore.pendingCount()).toBe(1);
  });

  it("hides tombstoned records and the entries that referenced them", async () => {
    const food = remoteFood("food00000000001", "Remote oats");
    const entry = remoteEntry("entry0000000001", food.id, TODAY, 0);
    await localStore.applyRemote({ foods: [food], entries: [entry], settings: null }, 2, "2026-08-21T09:00:00.000Z");
    expect(localStore.day(TODAY).entries).toHaveLength(1);

    await localStore.applyRemote({
      foods: [{ ...food, deleted: true, editedAt: "2099-01-01T00:00:00.000Z", revision: 5 }],
      entries: [], settings: null
    }, 5, "2026-08-21T09:05:00.000Z");

    expect(localStore.day(TODAY).entries).toHaveLength(0);
    expect(localStore.getSnapshot().foods).toHaveLength(0);
  });

  it("stops retrying a record the server refused", async () => {
    const food = await localStore.saveFood(foodInput());
    expect(localStore.pendingCount()).toBe(1);

    await localStore.discardPending("foods", food.id);

    expect(localStore.pendingCount()).toBe(0);
    expect(localStore.pendingChanges().foods).toHaveLength(0);
  });

  it("gives two edits of one record in the same millisecond distinguishable timestamps", async () => {
    const food = await localStore.saveFood(foodInput({ name: "First" }));
    const second = await localStore.saveFood(foodInput({ name: "Second" }), food.id);
    const third = await localStore.saveFood(foodInput({ name: "Third" }), food.id);

    expect(second.editedAt < third.editedAt).toBe(true);
  });
});

describe("replica lifecycle", () => {
  it("discards a replica belonging to a different account rather than converting it", async () => {
    await localStore.saveFood(foodInput());
    expect(localStore.getSnapshot().foods).toHaveLength(1);

    await localStore.load("someone-else");

    expect(localStore.getSnapshot().foods).toHaveLength(0);
    expect(localStore.cursor()).toBe(0);
  });

  it("reopens the same account's replica with its queue intact", async () => {
    await localStore.saveFood(foodInput());
    await localStore.load("owner-1");

    expect(localStore.getSnapshot().foods).toHaveLength(1);
    expect(localStore.pendingCount()).toBe(1);
  });
});

describe("resetting and seeding", () => {
  it("seeds the catalogue only into an account that holds nothing at all", async () => {
    expect(await localStore.seedIfEmpty()).toBe(true);
    const foods = localStore.getSnapshot().foods;
    expect(foods).toHaveLength(defaultCatalog.length);
    expect(foods.map((food) => food.id).sort()).toEqual(defaultCatalog.map((food) => food.id).sort());
    // Every seeded food is a local change, so the account the owner just signed into on a second
    // device converges on one catalogue rather than two.
    expect(localStore.pendingCount()).toBe(defaultCatalog.length);

    expect(await localStore.seedIfEmpty()).toBe(false);
    expect(localStore.getSnapshot().foods).toHaveLength(defaultCatalog.length);
  });

  it("does not seed over a catalogue the owner has emptied on another device", async () => {
    const food = await localStore.saveFood(foodInput({ name: "Deleted later" }));
    await localStore.deleteFood(food.id);

    expect(localStore.getSnapshot().foods).toHaveLength(0);
    // Only tombstones remain, and a tombstone is still a record: this account has been used.
    expect(await localStore.seedIfEmpty()).toBe(false);
  });

  it("empties the account, clears targets, and restores the catalogue", async () => {
    const food = await localStore.saveFood(foodInput({ name: "Leftover pizza" }));
    await localStore.addEntry(TODAY, food.id, 200, "dinner");
    await localStore.saveTargets({ calories: 2200, protein: 150, fat: null, carbs: null });

    await localStore.resetToDefaults();

    const snapshot = localStore.getSnapshot();
    expect(snapshot.foods.map((item) => item.name)).not.toContain("Leftover pizza");
    expect(snapshot.foods).toHaveLength(defaultCatalog.length);
    expect(snapshot.targets).toEqual({ calories: null, protein: null, fat: null, carbs: null });
    expect(localStore.day(TODAY).entries).toHaveLength(0);

    // The deletions have to reach the owner's other devices, so they travel as tombstones rather
    // than simply vanishing from this replica.
    const pending = localStore.pendingChanges();
    expect(pending.foods.find((item) => item.name === "Leftover pizza")?.deleted).toBe(true);
    expect(pending.entries.every((entry) => entry.deleted)).toBe(true);
    expect(pending.settings?.targets.calories).toBeNull();
    expect(pending.settings?.contributionThreshold).toBe(DEFAULT_CONTRIBUTION_THRESHOLD);
  });

  it("brings a catalogue food back after an earlier reset tombstoned it", async () => {
    await localStore.seedIfEmpty();
    const seeded = localStore.getSnapshot().foods[0];
    await localStore.deleteFood(seeded.id);
    expect(localStore.food(seeded.id)).toBeNull();

    await localStore.resetToDefaults();

    const restored = localStore.food(seeded.id);
    expect(restored?.name).toBe(seeded.name);
    expect(restored?.deleted).toBe(false);
  });
});
