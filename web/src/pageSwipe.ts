import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

/**
 * A second gesture on the same touch surface as `rowGestures.ts`, but arbitrating a different
 * press: not "what does a hold on this row mean" but "is this drag meant for the whole day."
 * A press that starts on a row is left entirely alone here, so the two never compete for it.
 */

/** Movement allowed before a direction is decided. Larger than a row's own tolerance: a misfired
    page-wide day change is more disruptive than a misfired row reveal, so it is worth costing a
    little more certainty first. */
const DEADZONE = 10;
/** How much more sideways than vertical a movement must be to count as a swipe, not a scroll.
    Higher than a row's bias because this gesture is contending with the whole log's own vertical
    scroll, not just one row's. */
const DIRECTION_BIAS = 1.75;
/** Raw finger travel needed on release to commit to a day change. A fixed distance, not a share
    of the container's width, so the gesture feels the same on a phone and on a tablet. */
const COMMIT_DISTANCE = 72;
/** The visual offset is a damped fraction of the raw drag, capped well short of the finger's own
    travel, so the content only ever nudges rather than tracks the drag outright — the "light"
    the live-follow is named for. The commit decision still reads the raw, undamped distance. */
const FOLLOW_RATE = 0.35;
const FOLLOW_CAP = 28;
/** How long the offset takes to return to rest once the finger lifts. */
const SETTLE_MS = 160;

type Phase = "watching" | "dragging";

interface Pending {
  pointerId: number;
  phase: Phase;
  x: number;
  y: number;
}

export interface PageSwipeOptions {
  /** False while installed-app/native-host/mode gating says this gesture should not react at all. */
  enabled: boolean;
  onPrevious(): void;
  onNext(): void;
}

export interface PageSwipe {
  containerProps: { onPointerDown(event: ReactPointerEvent): void };
  /** Present only while a drag is live or settling back to rest; absent otherwise so the resting
      DOM carries no inline style to fight the stylesheet's own transition. */
  drag: { offset: number; settling: boolean } | undefined;
}

function follow(dx: number): number {
  return Math.max(-FOLLOW_CAP, Math.min(FOLLOW_CAP, dx * FOLLOW_RATE));
}

export function usePageSwipe({ enabled, onPrevious, onNext }: PageSwipeOptions): PageSwipe {
  const pending = useRef<Pending | null>(null);
  const detach = useRef<(() => void) | undefined>(undefined);
  const [drag, setDrag] = useState<{ offset: number; settling: boolean } | undefined>(undefined);

  const settle = useCallback(() => {
    pending.current = null;
    detach.current?.();
    detach.current = undefined;
    setDrag((current) => {
      if (!current || current.offset === 0) return undefined;
      window.setTimeout(() => setDrag(undefined), SETTLE_MS);
      return { offset: 0, settling: true };
    });
  }, []);

  useEffect(() => settle, [settle]);
  // Anything that stands the gesture down mid-drag (a mode change, a modal opening) settles it,
  // rather than leaving a detached listener reacting to a finger the rest of the page has moved on from.
  useEffect(() => { if (!enabled) settle(); }, [enabled, settle]);

  const onPointerDown = useCallback((event: ReactPointerEvent) => {
    if (!enabled || event.pointerType === "mouse") return;
    if ((event.target as HTMLElement).closest("[data-drop-entry]")) return;
    pending.current = { pointerId: event.pointerId, phase: "watching", x: event.clientX, y: event.clientY };

    const move = (moveEvent: PointerEvent) => {
      const current = pending.current;
      if (!current || moveEvent.pointerId !== current.pointerId) return;
      const dx = moveEvent.clientX - current.x;
      const dy = moveEvent.clientY - current.y;
      if (current.phase === "watching") {
        if (Math.abs(dx) <= DEADZONE && Math.abs(dy) <= DEADZONE) return;
        if (Math.abs(dx) <= Math.abs(dy) * DIRECTION_BIAS) { settle(); return; }
        current.phase = "dragging";
      }
      moveEvent.preventDefault();
      setDrag({ offset: follow(dx), settling: false });
    };
    const up = (upEvent: PointerEvent) => {
      const current = pending.current;
      if (!current || upEvent.pointerId !== current.pointerId) return;
      if (current.phase === "dragging") {
        const dx = upEvent.clientX - current.x;
        if (dx <= -COMMIT_DISTANCE) onNext();
        else if (dx >= COMMIT_DISTANCE) onPrevious();
      }
      settle();
    };
    document.addEventListener("pointermove", move, { passive: false });
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
    detach.current = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
    };
  }, [enabled, onPrevious, onNext, settle]);

  return { containerProps: { onPointerDown }, drag };
}
