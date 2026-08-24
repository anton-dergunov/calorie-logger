import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backendSession } from "./api";
import { localDateString } from "./date";
import { localStore, SCHEMA_VERSION } from "./localStore";
import { shouldSyncWhenTriggered, syncEngine } from "./sync";
import type { Food, FoodInput, StoredEntry, SyncResponse } from "./types";

const TODAY = localDateString();

function foodInput(overrides: Partial<FoodInput> = {}): FoodInput {
  return {
    name: "Oats", icon: "pic:cereal", basisAmount: 100, unit: "g", source: null, oneOff: false,
    calories: 370, protein: 13, fat: 7, carbs: 62, ...overrides
  };
}

function reply(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(status < 400 ? { data: body } : { error: body }), {
    status, headers: { "Content-Type": "application/json" }
  }));
}

function syncReply(overrides: Partial<SyncResponse> = {}) {
  return reply({
    schemaVersion: 2,
    serverTime: "2026-08-21T09:00:00.000Z",
    cursor: 10,
    changes: { foods: [], entries: [], settings: null },
    rejected: [],
    ...overrides
  });
}

const fetchMock = vi.fn();

beforeEach(async () => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  backendSession.configure({ baseUrl: "https://calorie-logger.example.test", email: "person@example.test", token: "opaque-token" });
  await localStore.clear();
  await localStore.load("owner-1");
  syncEngine.stop();
});

afterEach(async () => {
  syncEngine.stop();
  backendSession.configure(null);
  vi.unstubAllGlobals();
  await localStore.clear();
});

function requestBody(call = 0) {
  return JSON.parse(String((fetchMock.mock.calls[call] as [string, RequestInit])[1].body));
}

describe("sync exchange", () => {
  it("pushes queued changes, advances the cursor, and empties the queue", async () => {
    const food = await localStore.saveFood(foodInput());
    await localStore.addEntry(TODAY, food.id, 100, "breakfast");
    fetchMock.mockImplementationOnce(() => syncReply({ cursor: 42 }));

    await syncEngine.syncNow();

    const body = requestBody();
    expect(body.schemaVersion).toBe(SCHEMA_VERSION);
    expect(body.since).toBe(0);
    expect(body.deviceId).toMatch(/^[a-z0-9]{15}$/);
    expect(body.changes.foods).toHaveLength(1);
    expect(body.changes.entries).toHaveLength(1);

    const status = syncEngine.getStatus();
    expect(status.state).toBe("idle");
    expect(status.pendingCount).toBe(0);
    expect(status.lastPulledAt).not.toBeNull();
    expect(status.lastPushedAt).not.toBeNull();
    expect(localStore.cursor()).toBe(42);
  });

  it("pulls another device's records and shows them straight away", async () => {
    const remoteFood: Food = {
      ...foodInput({ name: "Remote oats" }), id: "food00000000001",
      deleted: false, createdAt: "2026-08-20T00:00:00.000Z", editedAt: "2026-08-20T00:00:00.000Z",
      editedBy: "otherdevice0001", revision: 4
    };
    const remoteEntry: StoredEntry = {
      id: "entry0000000001", foodId: remoteFood.id, date: TODAY, meal: "lunch", sortIndex: 0, amount: 60,
      deleted: false, createdAt: "2026-08-20T00:00:00.000Z", editedAt: "2026-08-20T00:00:00.000Z",
      editedBy: "otherdevice0001", revision: 5
    };
    fetchMock.mockImplementationOnce(() => syncReply({ cursor: 5, changes: { foods: [remoteFood], entries: [remoteEntry], settings: null } }));

    await syncEngine.syncNow();

    expect(localStore.day(TODAY).entries.map((item) => item.name)).toEqual(["Remote oats"]);
    expect(localStore.cursor()).toBe(5);
  });

  it("sends the stored cursor so only unseen records come back", async () => {
    fetchMock.mockImplementationOnce(() => syncReply({ cursor: 7 }));
    await syncEngine.syncNow();

    fetchMock.mockImplementationOnce(() => syncReply({ cursor: 7 }));
    await syncEngine.syncNow();

    expect(requestBody(1).since).toBe(7);
  });

  it("reports a local change that lost to a newer edit from another device", async () => {
    const food = await localStore.saveFood(foodInput({ name: "Local name" }));
    const winner: Food = { ...food, name: "Their name", editedAt: "2099-01-01T00:00:00.000Z", editedBy: "otherdevice0001", revision: 9 };
    fetchMock.mockImplementationOnce(() => syncReply({
      cursor: 9,
      changes: { foods: [winner], entries: [], settings: null },
      rejected: [{ collection: "foods", id: food.id, reason: "superseded" }]
    }));

    await syncEngine.syncNow();

    expect(syncEngine.getStatus().supersededCount).toBe(1);
    expect(localStore.getSnapshot().foods[0].name).toBe("Their name");
    expect(syncEngine.getStatus().pendingCount).toBe(0);

    syncEngine.acknowledge();
    expect(syncEngine.getStatus().supersededCount).toBe(0);
  });

  it("stops retrying a record the server refused, without wedging the rest of the queue", async () => {
    const bad = await localStore.saveFood(foodInput({ name: "Rejected" }));
    const good = await localStore.saveFood(foodInput({ name: "Accepted" }));
    fetchMock.mockImplementationOnce(() => syncReply({
      cursor: 3,
      rejected: [{ collection: "foods", id: bad.id, reason: "invalid", message: "Choose an approved food picture." }]
    }));

    await syncEngine.syncNow();

    expect(syncEngine.getStatus().discardedCount).toBe(1);
    expect(syncEngine.getStatus().pendingCount).toBe(0);
    expect(localStore.getSnapshot().foods.map((item) => item.name)).toContain("Accepted");
    expect(good.id).not.toBe(bad.id);
  });
});

describe("sync failure", () => {
  it("keeps changes queued and reports being offline when nothing answers", async () => {
    await localStore.saveFood(foodInput());
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await syncEngine.syncNow();

    const status = syncEngine.getStatus();
    expect(status.state).toBe("offline");
    expect(status.pendingCount).toBe(1);
    // The panel is where someone looks when a device stops syncing, so it has to name what could
    // not be reached rather than leaving them to guess at the connection.
    expect(status.message).toContain("calorie-logger.example.test");
    expect(localStore.cursor()).toBe(0);
  });

  it("treats a broken server as offline rather than as an error the owner must fix", async () => {
    fetchMock.mockImplementationOnce(() => reply({ code: "server_error", message: "The server could not complete the request." }, 500));

    await syncEngine.syncNow();

    expect(syncEngine.getStatus().state).toBe("offline");
    expect(syncEngine.getStatus().message).toContain("could not complete");
  });

  it("blocks syncing and stops pushing when the record shape no longer matches", async () => {
    await localStore.saveFood(foodInput());
    fetchMock.mockImplementationOnce(() => reply({ code: "schema_version_mismatch", message: "Update the app to continue.", fields: { schemaVersion: 2 } }, 409));

    await syncEngine.syncNow();
    expect(syncEngine.getStatus().state).toBe("blocked");

    // A blocked client must not keep trying: writing the current shape from a stale build is
    // exactly how a replicated store gets corrupted.
    await syncEngine.syncNow();
    expect(fetchMock).toHaveBeenCalledOnce();
    // Local work is unaffected.
    expect(localStore.getSnapshot().foods).toHaveLength(1);
    expect(syncEngine.getStatus().pendingCount).toBe(1);
  });

  it("reports a signed-out session instead of exchanging anything", async () => {
    backendSession.configure(null);

    await syncEngine.syncNow();

    expect(syncEngine.getStatus().state).toBe("signedOut");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stays quiet about a sync that finishes quickly", async () => {
    // The status used to announce every exchange the moment it started, so the header flickered
    // several times a minute for work nobody was waiting on.
    fetchMock.mockImplementationOnce(() => syncReply());

    await syncEngine.syncNow();

    expect(syncEngine.getStatus().state).toBe("idle");
  });

  it("shows the syncing state at once for a sync the owner asked for", async () => {
    let release = (_: Response) => undefined as void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));

    const pending = syncEngine.syncNow(true);
    expect(syncEngine.getStatus().state).toBe("syncing");

    release(new Response(JSON.stringify({ data: { schemaVersion: 2, serverTime: "", cursor: 0, changes: { foods: [], entries: [], settings: null }, rejected: [] } }), { headers: { "Content-Type": "application/json" } }));
    await pending;
    expect(syncEngine.getStatus().state).toBe("idle");
  });

  it("runs one exchange at a time", async () => {
    fetchMock.mockImplementation(() => syncReply());

    await Promise.all([syncEngine.syncNow(), syncEngine.syncNow(), syncEngine.syncNow()]);

    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("a rebuilt server database", () => {
  it("re-uploads everything and pulls from the start instead of reporting a false sync", async () => {
    // This device synced happily against the previous database and holds records it believes are
    // safely uploaded. Then a deployment rebuilds the database and its revision sequence restarts
    // at zero, so this cursor now asks for revisions the new database will not reach for a long
    // time: the device pulls nothing, pushes nothing, and shows data no other device can see.
    const food = await localStore.saveFood(foodInput({ name: "Only on this device" }));
    await localStore.addEntry(TODAY, food.id, 60, "breakfast");
    fetchMock.mockReturnValueOnce(syncReply({ datasetId: "database-one", cursor: 40 }));
    await syncEngine.syncNow();
    expect(localStore.pendingCount()).toBe(0);
    expect(localStore.cursor()).toBe(40);

    const rebuilt = { foods: [] as Food[], entries: [] as StoredEntry[], settings: null };
    fetchMock.mockReturnValueOnce(syncReply({ datasetId: "database-two", cursor: 0, changes: rebuilt }));
    fetchMock.mockReturnValueOnce(syncReply({ datasetId: "database-two", cursor: 2, changes: rebuilt }));
    await syncEngine.syncNow();

    // The reply from the rebuilt database is not acted on; a second exchange follows immediately,
    // asking from the beginning and carrying this device's records back up.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const retry = requestBody(2);
    expect(retry.since).toBe(0);
    expect(retry.changes.foods.map((item: Food) => item.name)).toEqual(["Only on this device"]);
    expect(retry.changes.entries).toHaveLength(1);
    expect(localStore.cursor()).toBe(2);
    expect(localStore.pendingCount()).toBe(0);
    expect(syncEngine.getStatus().state).toBe("idle");
  });

  it("adopts the identity of a database it meets for the first time without a second exchange", async () => {
    fetchMock.mockReturnValueOnce(syncReply({ datasetId: "database-one", cursor: 3 }));
    await syncEngine.syncNow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(localStore.datasetId()).toBe("database-one");
    expect(localStore.cursor()).toBe(3);
  });
});

describe("whether a background trigger should run a sync", () => {
  function stubVisibility(state: DocumentVisibilityState) {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  }

  afterEach(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    delete window.webkit;
  });

  it("syncs a visible browser tab", () => {
    stubVisibility("visible");
    expect(shouldSyncWhenTriggered()).toBe(true);
  });

  it("does not sync a background browser tab", () => {
    stubVisibility("hidden");
    expect(shouldSyncWhenTriggered()).toBe(false);
  });

  it("keeps syncing the native macOS host even once its window is closed and reports itself hidden", () => {
    // This is the menu bar's actual failure mode: the window closes, WebKit marks the page
    // hidden, and only the native host must see through that to keep the popover fresh.
    stubVisibility("hidden");
    window.webkit = { messageHandlers: { calorieLogger: { postMessage: vi.fn() } } };
    expect(shouldSyncWhenTriggered()).toBe(true);
  });
});
