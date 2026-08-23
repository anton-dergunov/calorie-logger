import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SyncChip, SyncPanel } from "./SyncStatus";
import type { SyncStatus as Status } from "./sync";

afterEach(cleanup);

function status(overrides: Partial<Status> = {}): Status {
  return {
    state: "idle", pendingCount: 0, lastPulledAt: null, lastPushedAt: null,
    supersededCount: 0, discardedCount: 0, message: null, ...overrides
  };
}

describe("sync chip", () => {
  it("says what is happening without opening anything", () => {
    const { rerender } = render(<SyncChip status={status()} onOpen={() => undefined} />);
    expect(screen.getByRole("button").getAttribute("aria-label")).toContain("All changes synced");

    rerender(<SyncChip status={status({ pendingCount: 3 })} onOpen={() => undefined} />);
    expect(screen.getByRole("button").getAttribute("aria-label")).toContain("3 changes waiting");
    expect(screen.getByText("3")).not.toBeNull();

    rerender(<SyncChip status={status({ state: "offline", pendingCount: 1 })} onOpen={() => undefined} />);
    expect(screen.getByRole("button").getAttribute("aria-label")).toContain("Offline, 1 change waiting");

    rerender(<SyncChip status={status({ state: "blocked" })} onOpen={() => undefined} />);
    expect(screen.getByRole("button").getAttribute("aria-label")).toContain("Update required");
  });

  it("opens the details on activation", () => {
    const onOpen = vi.fn();
    render(<SyncChip status={status()} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalledOnce();
  });
});

describe("sync panel", () => {
  it("reports reachability, both transfer times, and the queue", () => {
    const now = Date.now();
    render(<SyncPanel
      persistent
      status={status({
        state: "offline",
        pendingCount: 3,
        lastPulledAt: new Date(now - 12 * 60_000).toISOString(),
        lastPushedAt: new Date(now - 2 * 3_600_000).toISOString()
      })}
      onSyncNow={() => undefined}
      onDismissConflicts={() => undefined}
    />);

    expect(screen.getByText("Unreachable")).not.toBeNull();
    expect(screen.getByText("12 minutes ago")).not.toBeNull();
    expect(screen.getByText("2 hours ago")).not.toBeNull();
    expect(screen.getByText("3 changes")).not.toBeNull();
  });

  it("shows never-transferred state and an empty queue plainly", () => {
    render(<SyncPanel persistent status={status()} onSyncNow={() => undefined} onDismissConflicts={() => undefined} />);
    expect(screen.getAllByText("Never")).toHaveLength(2);
    expect(screen.getByText("Nothing")).not.toBeNull();
    expect(screen.getByText("Connected")).not.toBeNull();
  });

  it("explains a superseded change once and lets it be dismissed", () => {
    const onDismissConflicts = vi.fn();
    render(<SyncPanel persistent status={status({ supersededCount: 1 })} onSyncNow={() => undefined} onDismissConflicts={onDismissConflicts} />);

    expect(screen.getByText(/was replaced by a newer edit from another device/)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismissConflicts).toHaveBeenCalledOnce();
  });

  it("says when this device could not open its storage", () => {
    render(<SyncPanel persistent={false} status={status()} onSyncNow={() => undefined} onDismissConflicts={() => undefined} />);
    expect(screen.getByText(/only held until you close the app/)).not.toBeNull();
  });

  it("does not offer a retry that cannot work while an update is required", () => {
    render(<SyncPanel persistent status={status({ state: "blocked" })} onSyncNow={() => undefined} onDismissConflicts={() => undefined} />);

    expect(screen.getByText("Update required")).not.toBeNull();
    expect((screen.getByRole("button", { name: "Sync now" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
