import { CalorieLoggerApiError, backendSession, postSync } from "./api";
import { nowInstant } from "./ids";
import { SCHEMA_VERSION, localStore } from "./localStore";
import type { RecordStore } from "./localDatabase";
import { isNativeHost } from "./session";

export type SyncState = "idle" | "syncing" | "offline" | "blocked" | "signedOut";

export interface SyncStatus {
  state: SyncState;
  pendingCount: number;
  lastPulledAt: string | null;
  lastPushedAt: string | null;
  /** Local changes replaced by a newer edit from another device, since the last acknowledgement. */
  supersededCount: number;
  /** Local changes the server refused outright, since the last acknowledgement. */
  discardedCount: number;
  message: string | null;
}

// Matches the cadence clients already refreshed at, so another device's entries appear
// about as quickly as they did before. A sync that has nothing to exchange is a small request.
const SYNC_INTERVAL = 15_000;
// A sync that finishes quickly should leave no trace. Announcing every exchange the moment it
// starts made the status flicker several times a minute for work the owner never waited on.
const SYNCING_VISIBLE_AFTER = 600;
const LOCAL_CHANGE_DELAY = 1_000;

const IDLE_STATUS: SyncStatus = {
  state: "signedOut", pendingCount: 0, lastPulledAt: null, lastPushedAt: null,
  supersededCount: 0, discardedCount: 0, message: null
};

/**
 * A background browser tab is paused to avoid pointless work, but the native macOS host keeps
 * running as a menu-bar icon after its window closes and is still the app the owner is using, so
 * it must keep syncing even while its `WKWebView` reports itself as hidden.
 */
export function shouldSyncWhenTriggered(): boolean {
  return isNativeHost() || document.visibilityState === "visible";
}

/**
 * A browser owns its own refresh cadence. The macOS host does not: WebKit may suspend an
 * off-screen page's timers, so AppKit wakes the interface on the same cadence instead.
 */
export function shouldSchedulePageSync(): boolean {
  return !isNativeHost();
}

/**
 * Exchanges local changes for remote ones.
 *
 * Nothing here decides what the owner may do — the interface has already written every edit to
 * the local replica by the time this runs. A sync that fails is not an error the owner has to
 * act on; it is simply a sync that will happen later.
 */
class SyncEngine {
  private status: SyncStatus = IDLE_STATUS;
  private listeners = new Set<() => void>();
  private running: Promise<void> | null = null;
  private timer: number | undefined;
  private debounce: number | undefined;
  private announce: number | undefined;
  private stops: (() => void)[] = [];

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getStatus = (): SyncStatus => this.status;

  private update(changes: Partial<SyncStatus>) {
    const times = localStore.syncTimes();
    this.status = {
      ...this.status,
      pendingCount: localStore.pendingCount(),
      lastPulledAt: times.lastPulledAt,
      lastPushedAt: times.lastPushedAt,
      ...changes
    };
    this.listeners.forEach((listener) => listener());
  }

  /** Called once the replica is loaded and a session exists. */
  start(): void {
    this.stop();
    this.update({ state: "idle", message: null });
    // Component tests drive the replica directly and must not have timers or network calls
    // started underneath them; `syncNow` still works when a test asks for it explicitly.
    if (import.meta.env.MODE === "test") return;
    const trigger = () => { void this.syncNow(); };
    const whenVisible = () => { if (shouldSyncWhenTriggered()) trigger(); };

    if (shouldSchedulePageSync()) this.timer = window.setInterval(whenVisible, SYNC_INTERVAL);
    window.addEventListener("focus", whenVisible);
    window.addEventListener("online", trigger);
    document.addEventListener("visibilitychange", whenVisible);
    this.stops.push(
      () => window.removeEventListener("focus", whenVisible),
      () => window.removeEventListener("online", trigger),
      () => document.removeEventListener("visibilitychange", whenVisible),
      localStore.onLocalChange(() => {
        window.clearTimeout(this.debounce);
        this.debounce = window.setTimeout(trigger, LOCAL_CHANGE_DELAY);
      })
    );
    trigger();
  }

  stop(): void {
    window.clearInterval(this.timer);
    window.clearTimeout(this.debounce);
    window.clearTimeout(this.announce);
    this.timer = undefined;
    this.debounce = undefined;
    this.announce = undefined;
    this.stops.forEach((stop) => stop());
    this.stops = [];
    this.status = IDLE_STATUS;
    this.listeners.forEach((listener) => listener());
  }

  /** Clears the conflict counters once the owner has seen them. */
  acknowledge(): void {
    this.update({ supersededCount: 0, discardedCount: 0, message: null });
  }

  /** `immediate` shows the syncing state at once, for a sync the owner asked for and is watching. */
  syncNow(immediate = false): Promise<void> {
    if (this.running) return this.running;
    this.running = this.exchange(immediate).finally(() => {
      window.clearTimeout(this.announce);
      this.announce = undefined;
      this.running = null;
    });
    return this.running;
  }

  private async exchange(immediate: boolean, restarted = false): Promise<void> {
    if (!backendSession.current()?.token) {
      this.update({ state: "signedOut" });
      return;
    }
    if (this.status.state === "blocked") return;
    if (immediate) this.update({ state: "syncing" });
    else this.announce = window.setTimeout(() => this.update({ state: "syncing" }), SYNCING_VISIBLE_AFTER);
    const pushed = localStore.pendingChanges();
    const pushing = pushed.foods.length + pushed.entries.length + (pushed.settings ? 1 : 0) > 0;
    try {
      const response = await postSync({
        schemaVersion: SCHEMA_VERSION,
        deviceId: localStore.deviceId(),
        since: localStore.cursor(),
        changes: pushed
      });
      // A different database than this cursor was counted in: the server was rebuilt, and this
      // reply was assembled for a cursor that means nothing here. Start replication over rather
      // than acting on it, then exchange again immediately with everything queued for upload.
      if (response.datasetId && response.datasetId !== localStore.datasetId()) {
        // A replica that has never pulled anything is already in the state a restart produces, so
        // this reply — assembled from cursor zero — still applies and only the identity is new.
        const pulledFromAnotherDatabase = localStore.cursor() > 0;
        await localStore.restartReplication(response.datasetId);
        if (pulledFromAnotherDatabase) {
          if (restarted) throw new Error("The server database changed again during this sync.");
          await this.exchange(immediate, true);
          return;
        }
      }

      const at = nowInstant();
      const superseded = await localStore.applyRemote(response.changes, response.cursor, at);

      let discarded = 0;
      for (const rejection of response.rejected) {
        if (rejection.reason !== "invalid") continue;
        await localStore.discardPending(rejection.collection as RecordStore, rejection.id);
        discarded += 1;
      }
      if (pushing) await localStore.confirmPushed(pushed, at);
      // Reaching a server that holds nothing, with nothing of our own, means a new account or one
      // whose database was rebuilt by a deployment. Seeding here rather than at startup is what
      // keeps a device that is merely offline from guessing at an empty account.
      await localStore.seedIfEmpty();

      this.update({
        state: "idle",
        supersededCount: this.status.supersededCount + superseded,
        discardedCount: this.status.discardedCount + discarded,
        message: null
      });
    } catch (error) {
      this.update(this.failure(error));
    }
  }

  private failure(error: unknown): Partial<SyncStatus> {
    if (!(error instanceof CalorieLoggerApiError)) {
      return { state: "offline", message: error instanceof Error ? error.message : String(error) };
    }
    if (error.code === "schema_version_mismatch") {
      return { state: "blocked", message: error.message };
    }
    if (error.status === 401) {
      return { state: "signedOut", message: error.message };
    }
    // Anything else means the server cannot currently store changes, which for the owner is the
    // same situation as being offline: keep working locally and try again later. The reason is
    // still worth carrying — the panel is where someone goes to find out why a device has stopped
    // syncing, and "unreachable" on its own sends them looking in the wrong place.
    return { state: "offline", message: error.message };
  }
}

export const syncEngine = new SyncEngine();
