import type { ReactElement } from "react";
import { relativeTime } from "./date";
import { installUpdate, updateStage } from "./pwa";
import type { SyncStatus } from "./sync";

function CloudOffIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M17.5 18H7a4 4 0 0 1-.7-7.94" />
    <path d="M8.6 6.6A5.5 5.5 0 0 1 17.5 10a3.9 3.9 0 0 1 3.2 5.4" />
    <path d="m3 3 18 18" />
  </svg>;
}

function CloudUpIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M17.5 18H7A4 4 0 0 1 7 10a5.5 5.5 0 0 1 10.5 0 3.9 3.9 0 0 1 0 8Z" />
    <path d="M12 16v-5" /><path d="m9.8 12.8 2.2-2.2 2.2 2.2" />
  </svg>;
}

function CloudDoneIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M17.5 18H7A4 4 0 0 1 7 10a5.5 5.5 0 0 1 10.5 0 3.9 3.9 0 0 1 0 8Z" />
    <path d="m9.5 13.6 1.8 1.8 3.4-3.6" />
  </svg>;
}

function AlertIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5" /><path d="M12 16.2h.01" />
  </svg>;
}

function SyncingIcon() {
  return <svg className="sync-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden="true">
    <path d="M12 3.5a8.5 8.5 0 1 1-8.02 5.7" />
  </svg>;
}

function serverLabel(status: SyncStatus): string {
  if (status.state === "blocked") return "Update required";
  if (status.state === "signedOut") return "Signed out";
  if (status.state === "offline") return "Unreachable";
  if (status.state === "syncing") return "Syncing…";
  return "Connected";
}

/** How the chip should read at a glance, without the owner having to open anything. */
function chipDetail(status: SyncStatus): { icon: ReactElement; tone: string; label: string } {
  if (status.state === "blocked") return { icon: <AlertIcon />, tone: "blocked", label: "Update required to sync" };
  if (status.state === "syncing") return { icon: <SyncingIcon />, tone: "syncing", label: "Syncing" };
  if (status.state === "offline") {
    return {
      icon: <CloudOffIcon />, tone: "offline",
      label: status.pendingCount
        ? `Offline, ${status.pendingCount} change${status.pendingCount === 1 ? "" : "s"} waiting`
        : "Offline"
    };
  }
  if (status.pendingCount) {
    return { icon: <CloudUpIcon />, tone: "pending", label: `${status.pendingCount} change${status.pendingCount === 1 ? "" : "s"} waiting` };
  }
  return { icon: <CloudDoneIcon />, tone: "synced", label: "All changes synced" };
}

export function SyncChip({ status, onOpen }: { status: SyncStatus; onOpen(): void }) {
  const detail = chipDetail(status);
  return <button className={`sync-chip sync-${detail.tone}`} onClick={onOpen} aria-label={`${detail.label}. Open sync details`} title={detail.label}>
    {detail.icon}
    {status.pendingCount > 0 && <span className="sync-count">{status.pendingCount}</span>}
  </button>;
}

export function SyncPanel({ status, persistent, onSyncNow, onDismissConflicts }: {
  status: SyncStatus;
  persistent: boolean;
  onSyncNow(): void;
  onDismissConflicts(): void;
}) {
  const waiting = status.pendingCount === 0
    ? "Nothing"
    : `${status.pendingCount} change${status.pendingCount === 1 ? "" : "s"}`;
  return <div className="sync-panel">
    <dl className="sync-facts">
      <div><dt>Server</dt><dd className={`sync-server sync-${status.state}`}>{serverLabel(status)}</dd></div>
      <div><dt>Downloaded</dt><dd>{relativeTime(status.lastPulledAt)}</dd></div>
      <div><dt>Uploaded</dt><dd>{relativeTime(status.lastPushedAt)}</dd></div>
      <div><dt>Waiting</dt><dd>{waiting}</dd></div>
    </dl>
    <p className="sync-explainer">
      Calorie Logger keeps a complete copy of your log on this device. Everything works without a
      connection, and changes upload on their own once the server can be reached.
    </p>
    {!persistent && <p className="sync-message" role="status">This device could not open its storage, so your log is only held until you close the app. Changes still upload.</p>}
    {status.state === "blocked" && <div className="sync-message" role="status">
      <p>This copy of Calorie Logger is older than the server and cannot sync until it is updated. Your log stays on this device in the meantime, and everything you enter keeps working.</p>
      {/* The update is usually already downloaded by this point, so the fix is one button rather
          than an instruction to close and reopen the app and hope. */}
      {updateStage() === "ready"
        ? <button className="primary-button" onClick={() => void installUpdate()}>Update now</button>
        : <p>Reopen Calorie Logger once it has downloaded the update.</p>}
    </div>}
    {status.message && <p className="sync-message" role="status">{status.message}</p>}
    {(status.supersededCount > 0 || status.discardedCount > 0) && <div className="sync-conflicts" role="status">
      <p>
        {status.supersededCount > 0 && `${status.supersededCount} offline change${status.supersededCount === 1 ? " was" : "s were"} replaced by a newer edit from another device. `}
        {status.discardedCount > 0 && `${status.discardedCount} change${status.discardedCount === 1 ? " could" : "s could"} not be saved by the server.`}
      </p>
      <button className="quiet-button" onClick={onDismissConflicts}>Dismiss</button>
    </div>}
    <footer className="form-actions">
      <button className="primary-button" onClick={onSyncNow} disabled={status.state === "syncing" || status.state === "signedOut" || status.state === "blocked"}>
        {status.state === "syncing" ? "Syncing…" : "Sync now"}
      </button>
    </footer>
  </div>;
}
