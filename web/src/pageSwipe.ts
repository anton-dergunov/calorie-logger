import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

/**
 * A second gesture on the same touch surface as `rowGestures.ts`, but arbitrating a different
 * press: not "what does a hold on this row mean" but "is this drag meant for the whole day".
 * A press that starts on a row is left entirely alone here, so the two never compete for it.
 *
 * The day is lifted by a bottom corner, the way a page in a book is: the right corner goes forward,
 * the left one back. Only that corner moves. A nudge of the whole page was too little to read as an
 * answer at all -- it looked like the browser's own pinch-zoom rubber-banding -- and turning the
 * whole page in perspective was too much, being a page-sized rotation under the reader's eyes every
 * time they changed day. The corner says the same thing without moving anything to say it.
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
/** Pixels of corner peeled back per pixel dragged, and the largest fold a drag alone can raise. A
    drag that has earned its day lifts a corner half the cap wide, which is a plain dog-ear well
    before it is let go. */
const FOLD_RATE = 1.5;
const FOLD_MAX = 170;
/** How far the corner carries on once the day is committed, as the page goes over. */
const FOLD_AWAY = 190;
/** Paired with the transitions and keyframes in `styles.css`. `LEAVE_MS` is also how long the day
    itself waits to change, so the page being turned is the one being left. */
const LEAVE_MS = 130;
const RETURN_MS = 180;
const ARRIVE_MS = 170;

type Phase = "watching" | "dragging";
type Towards = "next" | "previous";

interface Pending {
  pointerId: number;
  phase: Phase;
  x: number;
  y: number;
  towards: Towards | undefined;
}

export interface PageTurn {
  /** How far the corner has been peeled back, in pixels along each edge it runs. */
  fold: number;
  /** The bottom corner the page is lifted by. The right one goes forward, as in a book. */
  corner: "left" | "right";
  towards: Towards;
  stage: "dragging" | "leaving" | "arriving" | "returning";
}

export interface PageSwipeOptions {
  /** False while installed-app/native-host/mode gating says this gesture should not react at all. */
  enabled: boolean;
  onPrevious(): void;
  onNext(): void;
}

export interface PageSwipe {
  containerProps: { onPointerDown(event: ReactPointerEvent): void };
  /** Present only while the page is turning; absent at rest, so the resting DOM carries no inline
      transform to fight the stylesheet. */
  turn: PageTurn | undefined;
}

/** The page going over on its own is the one part of this the preference is asking about, so the day
    changes without it. The corner following the finger is direct manipulation and stays. */
function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

const cornerFor = (towards: Towards) => (towards === "next" ? "right" : "left");

export function usePageSwipe({ enabled, onPrevious, onNext }: PageSwipeOptions): PageSwipe {
  const pending = useRef<Pending | null>(null);
  const detach = useRef<(() => void) | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  /** True only while the leaving page is still on screen, when the day it belongs to has not
      changed yet and a second gesture would lose it. */
  const leaving = useRef(false);
  const [turn, setTurn] = useState<PageTurn | undefined>(undefined);

  const release = useCallback(() => {
    pending.current = null;
    detach.current?.();
    detach.current = undefined;
  }, []);

  const rest = useCallback(() => {
    release();
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = undefined;
    leaving.current = false;
    setTurn(undefined);
  }, [release]);

  useEffect(() => rest, [rest]);
  // Anything that stands the gesture down mid-turn -- a mode change, a modal opening -- puts the
  // page back rather than leaving it lifted with no finger on it.
  useEffect(() => { if (!enabled) rest(); }, [enabled, rest]);

  const settleBack = useCallback((towards: Towards) => {
    release();
    setTurn({ fold: 0, corner: cornerFor(towards), towards, stage: "returning" });
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { timer.current = undefined; setTurn(undefined); }, RETURN_MS);
  }, [release]);

  const commit = useCallback((towards: Towards) => {
    release();
    const step = towards === "next" ? onNext : onPrevious;
    if (reducedMotion()) { setTurn(undefined); step(); return; }
    leaving.current = true;
    setTurn({ fold: FOLD_AWAY, corner: cornerFor(towards), towards, stage: "leaving" });
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      leaving.current = false;
      step();
      setTurn({ fold: 0, corner: cornerFor(towards), towards, stage: "arriving" });
      timer.current = window.setTimeout(() => { timer.current = undefined; setTurn(undefined); }, ARRIVE_MS);
    }, LEAVE_MS);
  }, [release, onNext, onPrevious]);

  const onPointerDown = useCallback((event: ReactPointerEvent) => {
    if (!enabled || event.pointerType === "mouse") return;
    if ((event.target as HTMLElement).closest("[data-drop-entry]")) return;
    // A second finger is a pinch, and a pinch spreads sideways: read as a drag it would turn the
    // page while the owner was only trying to zoom.
    if (pending.current) {
      if (pending.current.phase === "dragging" && pending.current.towards) settleBack(pending.current.towards);
      else release();
      return;
    }
    if (leaving.current) return;
    // An arrival still settling is cut short rather than left to clear itself out from under the
    // gesture that is starting now.
    if (timer.current) rest();

    const start: Pending = { pointerId: event.pointerId, phase: "watching", x: event.clientX, y: event.clientY, towards: undefined };
    pending.current = start;

    const move = (moveEvent: PointerEvent) => {
      const current = pending.current;
      if (!current || moveEvent.pointerId !== current.pointerId) return;
      const dx = moveEvent.clientX - current.x;
      const dy = moveEvent.clientY - current.y;
      if (current.phase === "watching") {
        if (Math.abs(dx) <= DEADZONE && Math.abs(dy) <= DEADZONE) return;
        if (Math.abs(dx) <= Math.abs(dy) * DIRECTION_BIAS) { release(); return; }
        current.phase = "dragging";
      }
      moveEvent.preventDefault();
      current.towards = dx < 0 ? "next" : "previous";
      setTurn({
        fold: Math.min(FOLD_MAX, Math.abs(dx) * FOLD_RATE),
        corner: cornerFor(current.towards), towards: current.towards, stage: "dragging"
      });
    };
    const up = (upEvent: PointerEvent) => {
      const current = pending.current;
      if (!current || upEvent.pointerId !== current.pointerId) return;
      if (current.phase !== "dragging") { release(); return; }
      const dx = upEvent.clientX - current.x;
      if (dx <= -COMMIT_DISTANCE) commit("next");
      else if (dx >= COMMIT_DISTANCE) commit("previous");
      else settleBack(current.towards ?? "next");
    };
    document.addEventListener("pointermove", move, { passive: false });
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
    detach.current = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
    };
  }, [enabled, release, rest, settleBack, commit]);

  return { containerProps: { onPointerDown }, turn };
}
