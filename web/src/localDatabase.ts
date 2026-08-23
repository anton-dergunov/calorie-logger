import type { Food, StoredEntry, StoredTargets } from "./types";

const DATABASE_NAME = "calorie-logger";
const DATABASE_VERSION = 1;
const RECORD_STORES = ["foods", "entries", "settings"] as const;
const STORES = [...RECORD_STORES, "pending", "meta"] as const;

export type RecordStore = (typeof RECORD_STORES)[number];
const SETTINGS_KEY = "settings";

export interface DatabaseMeta {
  deviceId: string;
  ownerId: string;
  schemaVersion: number;
  /** The server database `cursor` counts revisions in. It changes when that database is rebuilt. */
  datasetId: string;
  cursor: number;
  lastPulledAt: string | null;
  lastPushedAt: string | null;
}

export interface DatabaseContents {
  foods: Food[];
  entries: StoredEntry[];
  settings: StoredTargets | null;
  pending: string[];
  meta: Partial<DatabaseMeta>;
}

/** One atomic unit of work. Records and their pending markers must move together, otherwise a
 *  crash between the two writes loses track of a change that was never uploaded. */
export interface DatabaseWrite {
  foods?: Food[];
  entries?: StoredEntry[];
  settings?: StoredTargets;
  addPending?: string[];
  clearPending?: string[];
  meta?: Partial<DatabaseMeta>;
}

export function pendingKey(store: RecordStore, id: string): string {
  return `${store}:${id}`;
}

interface Backend {
  read(): Promise<DatabaseContents>;
  write(changes: DatabaseWrite): Promise<void>;
  wipe(): Promise<void>;
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}

class IndexedDatabase implements Backend {
  private handle: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.handle) return this.handle;
    this.handle = new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      opening.onupgradeneeded = () => {
        const database = opening.result;
        STORES.forEach((store) => {
          if (!database.objectStoreNames.contains(store)) database.createObjectStore(store);
        });
      };
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    return this.handle;
  }

  async read(): Promise<DatabaseContents> {
    const database = await this.open();
    const transaction = database.transaction(STORES, "readonly");
    const [foods, entries, settings, pending, metaKeys, metaValues] = await Promise.all([
      request(transaction.objectStore("foods").getAll()),
      request(transaction.objectStore("entries").getAll()),
      request(transaction.objectStore("settings").get(SETTINGS_KEY)),
      request(transaction.objectStore("pending").getAllKeys()),
      request(transaction.objectStore("meta").getAllKeys()),
      request(transaction.objectStore("meta").getAll())
    ]);
    const meta: Record<string, unknown> = {};
    metaKeys.forEach((key, index) => { meta[String(key)] = metaValues[index]; });
    return {
      foods: foods as Food[],
      entries: entries as StoredEntry[],
      settings: (settings as StoredTargets | undefined) ?? null,
      pending: pending.map(String),
      meta: meta as Partial<DatabaseMeta>
    };
  }

  async write(changes: DatabaseWrite): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(STORES, "readwrite");
    changes.foods?.forEach((food) => transaction.objectStore("foods").put(food, food.id));
    changes.entries?.forEach((entry) => transaction.objectStore("entries").put(entry, entry.id));
    if (changes.settings) transaction.objectStore("settings").put(changes.settings, SETTINGS_KEY);
    changes.addPending?.forEach((key) => transaction.objectStore("pending").put(true, key));
    changes.clearPending?.forEach((key) => transaction.objectStore("pending").delete(key));
    Object.entries(changes.meta ?? {}).forEach(([key, value]) => transaction.objectStore("meta").put(value, key));
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  async wipe(): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(STORES, "readwrite");
    STORES.forEach((store) => transaction.objectStore(store).clear());
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }
}

/** Used under test and anywhere IndexedDB is unavailable. The app still works for the session;
 *  it simply starts empty next time and pulls everything again. */
class MemoryDatabase implements Backend {
  private contents: DatabaseContents = { foods: [], entries: [], settings: null, pending: [], meta: {} };

  async read(): Promise<DatabaseContents> {
    return {
      foods: [...this.contents.foods],
      entries: [...this.contents.entries],
      settings: this.contents.settings,
      pending: [...this.contents.pending],
      meta: { ...this.contents.meta }
    };
  }

  async write(changes: DatabaseWrite): Promise<void> {
    const replace = <T extends { id: string }>(list: T[], updates: T[] | undefined) => {
      if (!updates) return list;
      const next = [...list];
      updates.forEach((update) => {
        const index = next.findIndex((item) => item.id === update.id);
        if (index >= 0) next[index] = update; else next.push(update);
      });
      return next;
    };
    const pending = new Set(this.contents.pending);
    changes.addPending?.forEach((key) => pending.add(key));
    changes.clearPending?.forEach((key) => pending.delete(key));
    this.contents = {
      foods: replace(this.contents.foods, changes.foods),
      entries: replace(this.contents.entries, changes.entries),
      settings: changes.settings ?? this.contents.settings,
      pending: [...pending],
      meta: { ...this.contents.meta, ...changes.meta }
    };
  }

  async wipe(): Promise<void> {
    this.contents = { foods: [], entries: [], settings: null, pending: [], meta: {} };
  }
}

function usable(): boolean {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    return false;
  }
}

export const localDatabase: Backend = usable() ? new IndexedDatabase() : new MemoryDatabase();
export const memoryDatabase = () => new MemoryDatabase();
