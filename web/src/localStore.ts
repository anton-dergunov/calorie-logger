import { moveDate } from "./date";
import { defaultCatalog } from "./defaultCatalog";
import { localDatabase, memoryDatabase, pendingKey, type DatabaseMeta, type DatabaseWrite, type RecordStore } from "./localDatabase";
import { newDeviceId, newId, nowInstant } from "./ids";
import {
  DEFAULT_CONTRIBUTION_THRESHOLD, emptyNutrition, emptyTargets, scaledNutrition, sumNutrition, supersedes,
  type DayData, type EntryPlacement, type ExportDocument, type ExportRequest, type Food, type FoodInput,
  type FoodUsage, type LogEntry, type Meal, type StoredEntry, type StoredTargets, type SyncChanges,
  type SyncFields, type Targets
} from "./types";

/** Replicated record shape. The server refuses to merge a client that disagrees. */
export const SCHEMA_VERSION = 4;
const EXPORT_SCHEMA_VERSION = 5;
const MEAL_ORDER: Meal[] = ["breakfast", "lunch", "dinner", "snack"];
const SETTINGS_ID = "settings";

export interface StoreSnapshot {
  ready: boolean;
  foods: Food[];
  targets: Targets;
  /** Minutes after local midnight a new day begins. 0 (the default) is plain midnight. */
  dayRolloverMinutes: number;
  /** Percentage of a daily target above which a food is flagged in the log. 0 turns flagging off. */
  contributionThreshold: number;
  pendingCount: number;
  /** False when this device could not open its database and is holding the log in memory only. */
  persistent: boolean;
}

/** The settings the owner edits together in Preferences, written as one record. */
export type Preferences = Pick<StoredTargets, "dayRolloverMinutes" | "contributionThreshold">;

const EMPTY_SNAPSHOT: StoreSnapshot = {
  ready: false,
  foods: [],
  targets: emptyTargets(),
  dayRolloverMinutes: 0,
  contributionThreshold: DEFAULT_CONTRIBUTION_THRESHOLD,
  pendingCount: 0,
  persistent: true
};

function entryOrder(left: StoredEntry, right: StoredEntry): number {
  return left.sortIndex - right.sortIndex || left.id.localeCompare(right.id);
}

/**
 * The complete personal dataset, held in memory and mirrored to IndexedDB.
 *
 * Every read and write in the interface goes through here and never touches the network, so the
 * app behaves identically whether or not a server is reachable. Synchronisation is a separate
 * concern layered on top: it collects what is pending, hands back what other devices wrote, and
 * has no say in whether an edit is allowed.
 */
class LocalStore {
  private foods = new Map<string, Food>();
  private entries = new Map<string, StoredEntry>();
  private settings: StoredTargets | null = null;
  private pending = new Set<string>();
  private meta: DatabaseMeta = { deviceId: "", ownerId: "", schemaVersion: SCHEMA_VERSION, datasetId: "", cursor: 0, lastPulledAt: null, lastPushedAt: null };
  private snapshot: StoreSnapshot = EMPTY_SNAPSHOT;
  private listeners = new Set<() => void>();
  private changeListeners = new Set<() => void>();
  private lastInstant = "";
  private persistent = true;
  private backend = localDatabase;

  /* ------------------------------- lifecycle ------------------------------- */

  /**
   * Loads the replica for one account. A database written by a different account or by an older
   * record shape is discarded rather than converted: the app has no data worth preserving across
   * a schema change, and conversion code long outlives the change that justified it.
   */
  async load(ownerId: string): Promise<void> {
    try {
      await this.open(ownerId);
    } catch {
      // A device that cannot open its database must still be usable. The log is held in memory
      // for this session and still synchronises; it simply does not survive a reload.
      this.backend = memoryDatabase();
      this.persistent = false;
      await this.open(ownerId);
    }
  }

  private async open(ownerId: string): Promise<void> {
    const contents = await this.backend.read();
    const stale = contents.meta.schemaVersion !== SCHEMA_VERSION || (contents.meta.ownerId ?? "") !== ownerId;
    const deviceId = contents.meta.deviceId || newDeviceId();
    if (stale) {
      await this.backend.wipe();
      this.foods = new Map();
      this.entries = new Map();
      this.settings = null;
      this.pending = new Set();
      this.meta = { deviceId, ownerId, schemaVersion: SCHEMA_VERSION, datasetId: "", cursor: 0, lastPulledAt: null, lastPushedAt: null };
      await this.backend.write({ meta: this.meta });
    } else {
      this.foods = new Map(contents.foods.map((food) => [food.id, food]));
      this.entries = new Map(contents.entries.map((entry) => [entry.id, entry]));
      this.settings = contents.settings;
      this.pending = new Set(contents.pending);
      this.meta = { ...this.meta, ...contents.meta, deviceId, ownerId };
    }
    this.publish(true);
  }

  async clear(): Promise<void> {
    await this.backend.wipe();
    this.foods = new Map();
    this.entries = new Map();
    this.settings = null;
    this.pending = new Set();
    this.snapshot = EMPTY_SNAPSHOT;
    this.listeners.forEach((listener) => listener());
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): StoreSnapshot => this.snapshot;

  /** Fires after a local edit, so synchronisation can be attempted promptly. */
  onLocalChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }

  deviceId(): string { return this.meta.deviceId; }
  cursor(): number { return this.meta.cursor; }
  datasetId(): string { return this.meta.datasetId; }
  syncTimes() { return { lastPulledAt: this.meta.lastPulledAt, lastPushedAt: this.meta.lastPushedAt }; }
  pendingCount(): number { return this.pending.size; }

  /* -------------------------------- reads -------------------------------- */

  food(id: string): Food | null {
    const food = this.foods.get(id);
    return food && !food.deleted ? food : null;
  }

  /** An external food already in the catalogue, so a second scan reuses it instead of duplicating. */
  foodBySource(provider: string, sourceId: string): Food | null {
    for (const food of this.foods.values()) {
      if (!food.deleted && food.source?.provider === provider && food.source.id === sourceId) return food;
    }
    return null;
  }

  day(date: string): DayData {
    const entries = this.liveEntries()
      .filter((entry) => entry.date === date)
      .sort(entryOrder)
      .map((entry) => this.viewEntry(entry))
      .filter((entry): entry is LogEntry => entry !== null);
    return { date, entries, totals: sumNutrition(entries) };
  }

  /** What a reset would remove, for the confirmation that asks about it. */
  dataSummary(): { foodCount: number; entryCount: number } {
    return {
      foodCount: [...this.foods.values()].filter((food) => !food.deleted).length,
      entryCount: this.liveEntries().length
    };
  }

  /**
   * How often a food is used, and how much of it was last logged.
   *
   * `lastAmount` is derived from the entries the replica already holds, for the same reason
   * ranking is: a stored "last amount" would carry a fresh edit timestamp on every single entry
   * added, and under last-writer-wins that would let logging on one device overwrite a genuine
   * nutrition edit made on another.
   */
  foodUsage(id: string): FoodUsage {
    const used = this.liveEntries().filter((entry) => entry.foodId === id);
    const latest = used.reduce<StoredEntry | null>((newest, entry) => (
      !newest || entry.createdAt > newest.createdAt ? entry : newest
    ), null);
    return { entryCount: used.length, lastAmount: latest?.amount ?? null };
  }

  private liveEntries(): StoredEntry[] {
    return [...this.entries.values()].filter((entry) => !entry.deleted && this.food(entry.foodId));
  }

  /** Presentation and nutrition always come from the current saved food, never from the entry. */
  private viewEntry(entry: StoredEntry): LogEntry | null {
    const food = this.food(entry.foodId);
    if (!food) return null;
    return {
      id: entry.id,
      foodId: food.id,
      date: entry.date,
      name: food.name,
      icon: food.icon,
      amount: entry.amount,
      basisAmount: food.basisAmount,
      unit: food.unit,
      sortIndex: entry.sortIndex,
      meal: entry.meal,
      createdAt: entry.createdAt,
      editedAt: entry.editedAt,
      ...scaledNutrition(food, entry.amount)
    };
  }

  /**
   * Most recently used first, then unused foods by name.
   *
   * This is derived from the entries the replica already holds rather than stored on the food.
   * A stored "last used" field would have to carry a fresh edit timestamp on every single entry
   * added, which under last-writer-wins would let a usage bump on one device silently overwrite
   * a genuine name or nutrition edit made on another.
   */
  private rankedFoods(): Food[] {
    const lastUsed = new Map<string, string>();
    this.entries.forEach((entry) => {
      if (entry.deleted) return;
      const current = lastUsed.get(entry.foodId);
      if (!current || entry.createdAt > current) lastUsed.set(entry.foodId, entry.createdAt);
    });
    return [...this.foods.values()].filter((food) => !food.deleted).sort((left, right) => {
      const leftUsed = lastUsed.get(left.id);
      const rightUsed = lastUsed.get(right.id);
      if (leftUsed && rightUsed) return rightUsed.localeCompare(leftUsed);
      if (leftUsed) return -1;
      if (rightUsed) return 1;
      return left.name.localeCompare(right.name);
    });
  }

  /* -------------------------------- writes -------------------------------- */

  /**
   * A strictly increasing timestamp for this device. Two edits to the same record within one
   * millisecond would otherwise be indistinguishable, and the second would be discarded as a
   * duplicate of the first.
   */
  private instant(): string {
    const now = nowInstant();
    const next = now > this.lastInstant ? now : new Date(Date.parse(this.lastInstant) + 1).toISOString();
    this.lastInstant = next;
    return next;
  }

  private stamp(created?: string): SyncFields {
    const at = this.instant();
    return { deleted: false, createdAt: created ?? at, editedAt: at, editedBy: this.meta.deviceId, revision: 0 };
  }

  private async commit(changes: { foods?: Food[]; entries?: StoredEntry[]; settings?: StoredTargets }): Promise<void> {
    const addPending: string[] = [];
    const mark = (store: RecordStore, id: string) => {
      const key = pendingKey(store, id);
      addPending.push(key);
      this.pending.add(key);
    };
    changes.foods?.forEach((food) => { this.foods.set(food.id, food); mark("foods", food.id); });
    changes.entries?.forEach((entry) => { this.entries.set(entry.id, entry); mark("entries", entry.id); });
    if (changes.settings) { this.settings = changes.settings; mark("settings", SETTINGS_ID); }
    this.publish(true);
    await this.backend.write({ ...changes, addPending });
    this.changeListeners.forEach((listener) => listener());
  }

  private nextIndex(date: string): number {
    return this.liveEntries()
      .filter((entry) => entry.date === date)
      .reduce((highest, entry) => Math.max(highest, entry.sortIndex + 1), 0);
  }

  async saveFood(input: FoodInput, id?: string): Promise<Food> {
    const existing = id ? this.foods.get(id) : undefined;
    const food: Food = { ...input, id: existing?.id ?? newId(), ...this.stamp(existing?.createdAt) };
    await this.commit({ foods: [food] });
    return food;
  }

  /** Deleting a food deletes every entry that uses it, on every device, deterministically. */
  async deleteFood(id: string): Promise<void> {
    const food = this.foods.get(id);
    if (!food) return;
    const entries = this.liveEntries().filter((entry) => entry.foodId === id)
      .map((entry) => ({ ...entry, ...this.stamp(entry.createdAt), deleted: true }));
    await this.commit({ foods: [{ ...food, ...this.stamp(food.createdAt), deleted: true }], entries });
  }

  /**
   * Empties this account and puts the shipped catalogue back.
   *
   * Everything is tombstoned and reseeded through the ordinary write path, so the reset travels
   * to the owner's other devices as plain last-writer-wins changes rather than needing a server
   * route, and it works with no server reachable at all. A catalogue food that was tombstoned by
   * an earlier reset comes back because its new stamp is later than the tombstone's.
   */
  async resetToDefaults(): Promise<void> {
    const foods = [...this.foods.values()]
      .filter((food) => !food.deleted)
      .map((food) => ({ ...food, ...this.stamp(food.createdAt), deleted: true }));
    const entries = [...this.entries.values()]
      .filter((entry) => !entry.deleted)
      .map((entry) => ({ ...entry, ...this.stamp(entry.createdAt), deleted: true }));
    const settings: StoredTargets = {
      id: this.settings?.id ?? SETTINGS_ID,
      targets: emptyTargets(),
      dayRolloverMinutes: 0,
      contributionThreshold: DEFAULT_CONTRIBUTION_THRESHOLD,
      ...this.stamp(this.settings?.createdAt)
    };
    await this.commit({ foods: [...foods, ...this.catalogueFoods()], entries, settings });
  }

  /**
   * Seeds the catalogue into an account that holds nothing at all.
   *
   * Tombstones count as holding something, so a food the owner deleted is never quietly
   * resurrected: only a genuinely untouched account — a new one, or one whose server database was
   * rebuilt — is empty by this measure.
   */
  async seedIfEmpty(): Promise<boolean> {
    if (this.foods.size || this.entries.size) return false;
    await this.commit({ foods: this.catalogueFoods() });
    return true;
  }

  private catalogueFoods(): Food[] {
    return defaultCatalog.map(({ id, ...input }) => ({ ...input, id, ...this.stamp() }));
  }

  async addEntry(date: string, foodId: string, amount: number, meal: Meal): Promise<void> {
    const entry: StoredEntry = { id: newId(), foodId, date, meal, amount, sortIndex: this.nextIndex(date), ...this.stamp() };
    await this.commit({ entries: [entry] });
  }

  async updateEntry(id: string, date: string, amount: number, meal: Meal, foodId?: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    const updated = { ...entry, date, amount, meal, foodId: foodId ?? entry.foodId, ...this.stamp(entry.createdAt) };
    await this.commit({ entries: [updated], foods: this.strandedOneOffs([updated]) });
  }

  async deleteEntries(ids: string[]): Promise<void> {
    const entries = ids
      .map((id) => this.entries.get(id))
      .filter((entry): entry is StoredEntry => entry !== undefined)
      .map((entry) => ({ ...entry, ...this.stamp(entry.createdAt), deleted: true }));
    if (entries.length) await this.commit({ entries, foods: this.strandedOneOffs(entries) });
  }

  /**
   * One-off foods that the given entry changes leave with nothing referencing them, tombstoned.
   *
   * A one-off exists only for the entries that use it and is never offered in the food list, so
   * once the last of them is gone it is unreachable rather than merely unused. Tombstoning it in
   * the same commit means the removal replicates as one change, and a device that has been
   * offline learns about both halves together.
   */
  private strandedOneOffs(changed: StoredEntry[]): Food[] {
    const changedIds = new Set(changed.map((entry) => entry.id));
    const candidates = new Set<string>();
    changed.forEach((entry) => {
      const previous = this.entries.get(entry.id);
      if (previous && (entry.deleted || previous.foodId !== entry.foodId)) candidates.add(previous.foodId);
    });
    const remaining = this.liveEntries()
      .filter((entry) => !changedIds.has(entry.id))
      .concat(changed.filter((entry) => !entry.deleted));
    return [...candidates]
      .map((foodId) => this.foods.get(foodId))
      .filter((food): food is Food => food !== undefined && !food.deleted && food.oneOff)
      .filter((food) => !remaining.some((entry) => entry.foodId === food.id))
      .map((food) => ({ ...food, ...this.stamp(food.createdAt), deleted: true }));
  }

  async reorderEntries(placements: EntryPlacement[]): Promise<void> {
    const entries = placements.map((placement, index) => {
      const entry = this.entries.get(placement.id);
      return entry ? { ...entry, meal: placement.meal, sortIndex: index, ...this.stamp(entry.createdAt) } : null;
    }).filter((entry): entry is StoredEntry => entry !== null);
    if (entries.length) await this.commit({ entries });
  }

  async copyEntries(ids: string[], destinationDate: string, meal?: Meal): Promise<void> {
    await this.appendCopies(this.orderedSources(ids), destinationDate, meal);
  }

  /**
   * Moves entries to another day, and optionally another meal, by re-dating the records themselves.
   *
   * A move keeps every id: tombstoning the originals and writing copies would make one intention
   * arrive at another device as two unrelated changes, and a replica that had only seen half of
   * them would show the food twice or not at all.
   */
  async moveEntries(ids: string[], destinationDate: string, meal?: Meal): Promise<void> {
    const sources = this.orderedSources(ids);
    if (!sources.length) return;
    let index = this.nextIndex(destinationDate);
    const entries = sources.map((source) => ({
      ...source, date: destinationDate, meal: meal ?? source.meal, sortIndex: index++,
      ...this.stamp(source.createdAt)
    }));
    await this.commit({ entries });
  }

  private orderedSources(ids: string[]): StoredEntry[] {
    return ids
      .map((id) => this.entries.get(id))
      .filter((entry): entry is StoredEntry => entry !== undefined && !entry.deleted)
      .sort((left, right) => left.date.localeCompare(right.date) || entryOrder(left, right));
  }

  async repeatPreviousDay(date: string): Promise<void> {
    await this.appendCopies(this.entriesOn(moveDate(date, -1)), date);
  }

  async repeatPreviousMeal(date: string, meal: Meal): Promise<void> {
    await this.appendCopies(this.entriesOn(moveDate(date, -1)).filter((entry) => entry.meal === meal), date);
  }

  private entriesOn(date: string): StoredEntry[] {
    return this.liveEntries().filter((entry) => entry.date === date).sort(entryOrder);
  }

  private async appendCopies(sources: StoredEntry[], destinationDate: string, meal?: Meal): Promise<void> {
    if (!sources.length) return;
    let index = this.nextIndex(destinationDate);
    const entries = sources.map((source) => {
      const copy: StoredEntry = {
        id: newId(), foodId: source.foodId, date: destinationDate, meal: meal ?? source.meal,
        amount: source.amount, sortIndex: index, ...this.stamp()
      };
      index += 1;
      return copy;
    });
    await this.commit({ entries });
  }

  async saveTargets(targets: Targets): Promise<Targets> {
    const record: StoredTargets = {
      id: this.settings?.id ?? SETTINGS_ID,
      targets,
      dayRolloverMinutes: this.settings?.dayRolloverMinutes ?? 0,
      contributionThreshold: this.settings?.contributionThreshold ?? DEFAULT_CONTRIBUTION_THRESHOLD,
      ...this.stamp(this.settings?.createdAt)
    };
    await this.commit({ settings: record });
    return targets;
  }

  async savePreferences(preferences: Preferences): Promise<Preferences> {
    const record: StoredTargets = {
      id: this.settings?.id ?? SETTINGS_ID,
      targets: this.settings?.targets ?? emptyTargets(),
      ...preferences,
      ...this.stamp(this.settings?.createdAt)
    };
    await this.commit({ settings: record });
    return preferences;
  }

  exportDocument(request: ExportRequest): ExportDocument {
    const inScope = (date: string) => request.scope === "all" || (date >= request.startDate && date <= request.endDate);
    const entries = this.liveEntries()
      .filter((entry) => inScope(entry.date))
      .sort((left, right) => left.date.localeCompare(right.date) || entryOrder(left, right))
      .map((entry) => this.viewEntry(entry))
      .filter((entry): entry is LogEntry => entry !== null);
    const referenced = new Set(entries.map((entry) => entry.foodId));
    const foods = this.rankedFoods().filter((food) => request.scope === "all" || referenced.has(food.id));
    return {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      exportedAt: nowInstant(),
      scope: request.scope,
      targets: this.snapshot.targets,
      foods,
      entries
    };
  }

  /* ------------------------------ replication ------------------------------ */

  /** Everything written locally that no server has accepted yet. */
  pendingChanges(): SyncChanges {
    const foods: Food[] = [];
    const entries: StoredEntry[] = [];
    let settingsPending = false;
    this.pending.forEach((key) => {
      const separator = key.indexOf(":");
      const store = key.slice(0, separator);
      const id = key.slice(separator + 1);
      if (store === "foods") { const food = this.foods.get(id); if (food) foods.push(food); }
      else if (store === "entries") { const entry = this.entries.get(id); if (entry) entries.push(entry); }
      else settingsPending = true;
    });
    return { foods, entries, settings: settingsPending ? this.settings : null };
  }

  /**
   * Applies records from the server, and reports how many pending local changes lost.
   *
   * The same last-writer-wins comparison runs here as on the server, which is what protects an
   * edit made while a sync was already in flight: a pulled record only replaces a local one when
   * it genuinely wins.
   */
  async applyRemote(changes: SyncChanges, cursor: number, pulledAt: string): Promise<number> {
    const write: DatabaseWrite = { foods: [], entries: [], clearPending: [] };
    let superseded = 0;
    const accept = (store: RecordStore, id: string, incoming: SyncFields, stored: SyncFields | undefined) => {
      if (!supersedes(incoming, stored)) return false;
      const key = pendingKey(store, id);
      if (this.pending.has(key)) {
        this.pending.delete(key);
        write.clearPending!.push(key);
        superseded += 1;
      }
      return true;
    };

    changes.foods.forEach((food) => {
      if (!accept("foods", food.id, food, this.foods.get(food.id))) return;
      this.foods.set(food.id, food);
      write.foods!.push(food);
    });
    changes.entries.forEach((entry) => {
      if (!accept("entries", entry.id, entry, this.entries.get(entry.id))) return;
      this.entries.set(entry.id, entry);
      write.entries!.push(entry);
    });
    if (changes.settings && accept("settings", SETTINGS_ID, changes.settings, this.settings ?? undefined)) {
      this.settings = { ...changes.settings, id: SETTINGS_ID };
      write.settings = this.settings;
    }

    this.meta = { ...this.meta, cursor, lastPulledAt: pulledAt };
    write.meta = { cursor, lastPulledAt: pulledAt };
    // A sync that brought nothing back must not repaint the day. The panel's own timestamps come
    // from the sync engine, so there is nothing for subscribers here to see.
    if (write.foods!.length || write.entries!.length || write.settings || write.clearPending!.length) this.publish(true);
    await this.backend.write(write);
    return superseded;
  }

  /**
   * Starts replication over against a server database this replica has never met.
   *
   * Every deployment during development rebuilds the database, which restarts the owner's
   * revision sequence at zero. A device that kept its old cursor would ask for revisions above a
   * number the new database has not reached, receive nothing, and report itself perfectly in
   * sync while showing data no other device can see. Records already accepted by the *previous*
   * database are equally invisible: their pending marks were cleared, so nothing would ever
   * upload them again.
   *
   * So the cursor goes back to zero and everything this replica holds — tombstones included, or
   * a deletion would be undone by another device that still has the record — becomes pending
   * again. The next exchange uploads the lot and pulls the new database from the beginning.
   */
  async restartReplication(datasetId: string): Promise<void> {
    const addPending: string[] = [];
    const mark = (store: RecordStore, id: string) => {
      const key = pendingKey(store, id);
      addPending.push(key);
      this.pending.add(key);
    };
    this.foods.forEach((food) => mark("foods", food.id));
    this.entries.forEach((entry) => mark("entries", entry.id));
    if (this.settings) mark("settings", SETTINGS_ID);
    this.meta = { ...this.meta, datasetId, cursor: 0 };
    this.publish(true);
    await this.backend.write({ addPending, meta: { datasetId, cursor: 0 } });
  }

  /** Clears the pending marks for records the server accepted and has not changed since. */
  async confirmPushed(pushed: SyncChanges, pushedAt: string): Promise<void> {
    const clearPending: string[] = [];
    const settle = (store: RecordStore, id: string, sent: SyncFields, current: SyncFields | undefined) => {
      // A record edited again while the push was in flight stays pending.
      if (!current || current.editedAt !== sent.editedAt || current.editedBy !== sent.editedBy) return;
      const key = pendingKey(store, id);
      if (!this.pending.delete(key)) return;
      clearPending.push(key);
    };
    pushed.foods.forEach((food) => settle("foods", food.id, food, this.foods.get(food.id)));
    pushed.entries.forEach((entry) => settle("entries", entry.id, entry, this.entries.get(entry.id)));
    if (pushed.settings) settle("settings", SETTINGS_ID, pushed.settings, this.settings ?? undefined);

    this.meta = { ...this.meta, lastPushedAt: pushedAt };
    if (clearPending.length) this.publish(true);
    await this.backend.write({ clearPending, meta: { lastPushedAt: pushedAt } });
  }

  /** Drops the pending mark for a record the server refused, so it is not retried forever. */
  async discardPending(store: RecordStore, id: string): Promise<void> {
    const key = pendingKey(store, id === "settings" ? SETTINGS_ID : id);
    if (!this.pending.delete(key)) return;
    this.publish(true);
    await this.backend.write({ clearPending: [key] });
  }

  private publish(ready: boolean): void {
    this.snapshot = {
      ready,
      foods: this.rankedFoods(),
      targets: this.settings?.targets ?? emptyTargets(),
      dayRolloverMinutes: this.settings?.dayRolloverMinutes ?? 0,
      contributionThreshold: this.settings?.contributionThreshold ?? DEFAULT_CONTRIBUTION_THRESHOLD,
      pendingCount: this.pending.size,
      persistent: this.persistent
    };
    this.listeners.forEach((listener) => listener());
  }
}

export const localStore = new LocalStore();
export { MEAL_ORDER };
