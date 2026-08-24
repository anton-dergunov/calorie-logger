import { useEffect, useRef, useState } from "react";
import { localDateString, moveDate } from "./date";

/**
 * A month grid drawn in the page.
 *
 * `<input type="date">` hands the calendar to the browser, which draws it outside the document at a
 * size nothing in CSS can reach — on macOS that popup is far too small to read. This one is ours:
 * the same on every platform, sized with the rest of the interface, and reachable from the keyboard.
 */
const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function noon(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

function monthLabel(value: string): string {
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(noon(value));
}

function dayLabel(value: string): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(noon(value));
}

function moveMonth(value: string, months: number): string {
  const date = noon(value);
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1, 12);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0, 12).getDate();
  target.setDate(Math.min(date.getDate(), lastDay));
  return localDateString(target);
}

/** Six weeks from the Monday on or before the first of the month, so the grid never changes height. */
function gridDays(value: string): string[] {
  const first = noon(value);
  first.setDate(1);
  const start = localDateString(first);
  const lead = (first.getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, index) => moveDate(start, index - lead));
}

export function MonthCalendar({ value, today, onChange }: { value: string; today: string; onChange(next: string): void }) {
  const [visible, setVisible] = useState(value);
  const [focused, setFocused] = useState(value);
  const grid = useRef<HTMLDivElement>(null);
  const takeFocus = useRef(false);

  useEffect(() => { setVisible(value); setFocused(value); }, [value]);
  useEffect(() => {
    if (!takeFocus.current) return;
    takeFocus.current = false;
    grid.current?.querySelector<HTMLButtonElement>(`[data-date="${focused}"]`)?.focus();
  }, [focused]);

  const step = (days: number, months = 0) => {
    const next = months ? moveMonth(focused, months) : moveDate(focused, days);
    takeFocus.current = true;
    setFocused(next);
    setVisible(next);
  };
  const keyed = (event: React.KeyboardEvent) => {
    const moves: Record<string, () => void> = {
      ArrowLeft: () => step(-1), ArrowRight: () => step(1),
      ArrowUp: () => step(-7), ArrowDown: () => step(7),
      Home: () => step(-((noon(focused).getDay() + 6) % 7)), End: () => step(6 - ((noon(focused).getDay() + 6) % 7)),
      PageUp: () => step(0, -1), PageDown: () => step(0, 1)
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    move();
  };
  const month = noon(visible).getMonth();

  return <div className="month-calendar">
    <div className="month-heading">
      <button type="button" className="month-step" onClick={() => setVisible(moveMonth(visible, -1))} aria-label="Previous month">‹</button>
      <strong aria-live="polite">{monthLabel(visible)}</strong>
      <button type="button" className="month-step" onClick={() => setVisible(moveMonth(visible, 1))} aria-label="Next month">›</button>
    </div>
    <div className="month-weekdays" aria-hidden="true">{WEEKDAYS.map((day) => <span key={day}>{day}</span>)}</div>
    <div className="month-grid" ref={grid} onKeyDown={keyed}>
      {gridDays(visible).map((day) => {
        const outside = noon(day).getMonth() !== month;
        return <button
          type="button"
          key={day}
          data-date={day}
          className={`month-day ${outside ? "is-outside" : ""} ${day === value ? "is-chosen" : ""} ${day === today ? "is-today" : ""}`}
          tabIndex={day === focused ? 0 : -1}
          aria-pressed={day === value}
          aria-current={day === today ? "date" : undefined}
          aria-label={dayLabel(day)}
          onFocus={() => setFocused(day)}
          onClick={() => onChange(day)}
        >{noon(day).getDate()}</button>;
      })}
    </div>
  </div>;
}
