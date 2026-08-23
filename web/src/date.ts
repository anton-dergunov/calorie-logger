export function localDateString(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * "Today" adjusted for a day-rollover time, so logging shortly after midnight but before the
 * rollover still counts against the previous calendar day. `rolloverMinutes = 0` is midnight and
 * matches `localDateString` exactly.
 */
export function currentLogDate(rolloverMinutes: number, now = new Date()): string {
  const minutesSinceMidnight = now.getHours() * 60 + now.getMinutes();
  if (minutesSinceMidnight < rolloverMinutes) {
    return localDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12));
  }
  return localDateString(now);
}

export function moveDate(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  return localDateString(new Date(year, month - 1, day + days, 12));
}

export function displayDate(value: string): { eyebrow: string; title: string } {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day, 12);
  return {
    eyebrow: new Intl.DateTimeFormat("en-GB", { weekday: "long" }).format(date),
    title: new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric"
    }).format(date)
  };
}

/** Compact "when did this last happen" text for the sync panel. */
export function relativeTime(value: string | null, now = new Date()): string {
  if (!value) return "Never";
  const elapsed = now.getTime() - Date.parse(value);
  if (!Number.isFinite(elapsed)) return "Never";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
