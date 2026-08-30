import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import {
  clampReach, clipPath, cornerPoint, foldGeometry, fullTurnReach, gradientAngle, gradientOffset,
  liftedCorner, type FoldCorner, type Point, type Rect, type Towards
} from "./pageFold";

/**
 * A second gesture on the same touch surface as `rowGestures.ts`, but arbitrating a different
 * press: not "what does a hold on this row mean" but "is this drag meant for the whole day".
 * A press that starts on a row is left entirely alone here, so the two never compete for it.
 *
 * The day is turned by a corner, the way a page in a book is: the half of the page the finger lands
 * in decides top or bottom, the way it travels decides forward or back, and the crease follows the
 * finger from there. Two earlier attempts missed on either side of this. A few pixels of drift
 * under the finger read as the browser's own pinch-zoom rubber-banding rather than as an answer;
 * turning the whole day in perspective was a page-sized rotation under the reader's eyes every time
 * they changed day, which was legible and faintly sickening. A corner is the part of a page that
 * actually moves when you turn one.
 */

/** Movement allowed before a direction is decided. Larger than a row's own tolerance: a misfired
    page-wide day change is more disruptive than a misfired row reveal, so it is worth costing a
    little more certainty first. */
const DEADZONE = 10;
/** How much more sideways than vertical a movement must be to count as a swipe, not a scroll.
    Higher than a row's bias because this gesture is contending with the whole log's own vertical
    scroll, not just one row's. */
const DIRECTION_BIAS = 1.75;
/** Raw finger travel needed on release to commit to a day change. A fixed distance, not a share of
    the page's width, so the gesture feels the same on a phone and on a tablet. Coupled to `REACH`:
    at this distance the crease stands this far in from the corner, about a fifth of a phone. */
const COMMIT_DISTANCE = 72;
/** How much further than the finger the corner itself is carried. Two, exactly, and not a taste
    knob: at two the crease's nearest point sits under the finger, so the crease travels with it one
    for one. Anything less and sweeping the page would need a drag longer than the page. */
const REACH = 2;
/** How steeply the corner may be carried, as a share of its sideways travel. */
const TILT = 0.7;
/** Finishing a turn the finger has already carried most of the way, scaled down by the distance
    still to cross so that the last tenth of a drag does not crawl. */
const SWEEP_MS = 240;
const SWEEP_FLOOR_MS = 90;
const RETURN_MS = 190;
/** How far the sheet below is carried past the crease, to keep the two edges from showing a seam. */
const SEAM_OVERLAP = 0.5;
/** How far behind the finger the paper trails. A first-order lag settles `TAU x velocity` behind,
    which at a flick would be a couple of hundred pixels -- hence the clamp, which is what actually
    decides the weight: the paper is never further behind than this, so a fast drag stays coupled to
    the finger while a slow one still has to be pulled. */
const FOLLOW_TAU_MS = 100;
const MAX_LAG = 40;
/** Near enough to the finger to stop asking for frames. Without it a finger held still spins rAF. */
const CAUGHT_UP = 0.05;

type Phase = "watching" | "dragging";

interface Pending {
  pointerId: number;
  phase: Phase;
  x: number;
  y: number;
  /** Latched once the drag begins. Recomputed per move, a wobble across the start would teleport a
      page-sized flap to the other side of the screen. */
  corner: FoldCorner | undefined;
  towards: Towards | undefined;
  /** Where the finger is, and where the paper has got to. Both are raw, unclamped travel: clamping
      snaps sideways travel to zero as the finger crosses back, and easing a signal that jumps
      traces a path the finger never took. */
  target: Point;
  drawn: Point;
}

/** A turn in progress. It says only which page is being turned and which way, because the shape it
    has at any moment never goes through React. */
export interface PageTurn {
  corner: FoldCorner;
  towards: Towards;
}

export interface PageSwipeOptions {
  /** False while installed-app/native-host/mode gating says the drag should not react at all. */
  enabled: boolean;
  onPrevious(): void;
  onNext(): void;
}

export interface PageSwipe {
  containerProps: { onPointerDown(event: ReactPointerEvent): void };
  /** The sheet underneath and the lifted flap. Written to directly, so a turn costs no render. */
  underRef: RefObject<HTMLDivElement | null>;
  flapRef: RefObject<HTMLDivElement | null>;
  turn: PageTurn | undefined;
}

/** The page going over on its own is the part of this the preference is asking about, so the day
    changes without it. A corner following a finger is direct manipulation and stays. */
function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** The page is the window. `clientWidth` is the honest answer where there is a scrollbar to leave
    out, and `innerWidth` covers the case where there has been no layout to ask about. */
function pageRect(): Rect {
  const width = document.documentElement.clientWidth || window.innerWidth;
  const height = document.documentElement.clientHeight || window.innerHeight;
  return { left: 0, top: 0, right: width, bottom: height };
}

const easeOut = (t: number) => 1 - (1 - t) * (1 - t) * (1 - t);

export function usePageSwipe({ enabled, onPrevious, onNext }: PageSwipeOptions): PageSwipe {
  const pending = useRef<Pending | null>(null);
  const detach = useRef<(() => void) | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);
  /** The day change a sweep has promised but not yet made. Dropping it would lose the day. */
  const pendingStep = useRef<(() => void) | undefined>(undefined);
  const underRef = useRef<HTMLDivElement | null>(null);
  const flapRef = useRef<HTMLDivElement | null>(null);
  const [turn, setTurn] = useState<PageTurn | undefined>(undefined);

  /** Draws one frame of the fold straight onto the two sheets, without troubling React. */
  const paint = useCallback((corner: FoldCorner, delta: Point) => {
    const under = underRef.current;
    const flap = flapRef.current;
    if (!under || !flap) return;
    const page = pageRect();
    const from = cornerPoint(page, corner);
    const carried = clampReach(corner, delta, TILT);
    const fold = foldGeometry(page, corner, {
      x: from.x + carried.x * REACH, y: from.y + carried.y * REACH
    }, SEAM_OVERLAP);
    if (!fold) { under.style.display = "none"; flap.style.display = "none"; return; }

    const { normal, at } = fold.crease;
    const beneath = clipPath(fold.under);
    under.style.display = beneath ? "block" : "none";
    under.style.clipPath = beneath;

    const box = { width: page.right, height: page.bottom };
    const angle = gradientAngle(normal);
    const tip = fold.flap.reduce((far, p) => Math.max(far, gradientOffset(box, angle, p)), 0);
    const path = clipPath(fold.flap);
    flap.style.display = path ? "block" : "none";
    flap.style.clipPath = path;
    flap.style.setProperty("--fold-angle", `${angle.toFixed(2)}deg`);
    flap.style.setProperty("--fold-crease", `${gradientOffset(box, angle, at).toFixed(2)}px`);
    flap.style.setProperty("--fold-tip", `${tip.toFixed(2)}px`);
    flap.style.setProperty("--fold-shadow-x", `${(-normal.x * 8).toFixed(2)}px`);
    flap.style.setProperty("--fold-shadow-y", `${(-normal.y * 8).toFixed(2)}px`);
  }, []);

  const release = useCallback(() => {
    pending.current = null;
    detach.current?.();
    detach.current = undefined;
  }, []);

  const rest = useCallback(() => {
    release();
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = undefined;
    // A turn stood down half way still owed a day. Pay it rather than swallow it.
    const owed = pendingStep.current;
    pendingStep.current = undefined;
    if (underRef.current) underRef.current.style.display = "none";
    if (flapRef.current) flapRef.current.style.display = "none";
    setTurn(undefined);
    owed?.();
  }, [release]);

  useEffect(() => rest, [rest]);
  // Anything that stands the gesture down mid-turn -- a mode change, a modal opening -- puts the
  // page back rather than leaving it lifted with no finger on it.
  useEffect(() => { if (!enabled) rest(); }, [enabled, rest]);
  // Insurance, and one-directional on purpose: this may hide the sheets but must never show them,
  // or it would race the tween that owns `display` while a turn is running.
  useLayoutEffect(() => {
    if (turn) return;
    if (underRef.current) underRef.current.style.display = "none";
    if (flapRef.current) flapRef.current.style.display = "none";
  }, [turn]);

  /**
   * The paper trailing the finger.
   *
   * The drawing lags; the decision does not. What is painted eases towards where the finger is,
   * while the commit is judged on the finger's own travel, so the page has some weight without the
   * gesture becoming harder to aim. Painting here rather than in the pointer handler also folds
   * several reports in one frame into a single paint, which a 120Hz screen delivers a lot of.
   */
  const follow = useCallback((corner: FoldCorner) => {
    if (frame.current) return;
    let last = performance.now();
    const step = () => {
      frame.current = undefined;
      const current = pending.current;
      if (!current || current.phase !== "dragging") return;
      const now = performance.now();
      const caught = 1 - Math.exp(-(now - last) / FOLLOW_TAU_MS);
      last = now;
      const target = current.target;
      const drawn = current.drawn;
      let x = drawn.x + (target.x - drawn.x) * caught;
      let y = drawn.y + (target.y - drawn.y) * caught;
      // A flick outruns any lag worth having, so the paper is never allowed to fall further behind
      // than this -- the crease is meant to sit under the finger, and far behind it reads as broken.
      if (Math.abs(target.x - x) > MAX_LAG) x = target.x - Math.sign(target.x - x) * MAX_LAG;
      if (Math.abs(target.y - y) > MAX_LAG) y = target.y - Math.sign(target.y - y) * MAX_LAG;
      current.drawn = { x, y };
      paint(corner, current.drawn);
      if (Math.hypot(target.x - x, target.y - y) < CAUGHT_UP) return;
      frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  }, [paint]);

  const animate = useCallback((corner: FoldCorner, from: Point, to: Point, ms: number, done: () => void) => {
    if (frame.current) cancelAnimationFrame(frame.current);
    const started = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - started) / ms);
      const eased = easeOut(t);
      paint(corner, { x: from.x + (to.x - from.x) * eased, y: from.y + (to.y - from.y) * eased });
      if (t < 1) { frame.current = requestAnimationFrame(step); return; }
      frame.current = undefined;
      done();
    };
    frame.current = requestAnimationFrame(step);
  }, [paint]);

  const settleBack = useCallback((corner: FoldCorner, towards: Towards, from: Point) => {
    release();
    animate(corner, from, { x: 0, y: 0 }, RETURN_MS, rest);
  }, [release, animate, rest]);

  /**
   * Carries the corner the rest of the way over, and hands the day across underneath it.
   *
   * The day changes on the last frame, when the sheet below already covers the window and is
   * already showing the day being arrived at. There is nothing to fade, because there is no frame
   * where the screen shows anything the arriving page does not.
   */
  const sweep = useCallback((corner: FoldCorner, towards: Towards, from: Point) => {
    const step = towards === "next" ? onNext : onPrevious;
    if (reducedMotion()) { rest(); step(); return; }
    const page = pageRect();
    const to = fullTurnReach(page, corner, TILT);
    const travelled = Math.min(1, Math.abs(from.x) / Math.max(1, Math.abs(to.x)));
    pendingStep.current = step;
    setTurn({ corner, towards });
    animate(corner, from, to, Math.max(SWEEP_FLOOR_MS, SWEEP_MS * (1 - travelled)), () => {
      pendingStep.current = undefined;
      step();
      setTurn(undefined);
    });
  }, [onNext, onPrevious, rest, animate]);

  const onPointerDown = useCallback((event: ReactPointerEvent) => {
    if (!enabled || event.pointerType === "mouse") return;
    if ((event.target as HTMLElement).closest("[data-drop-entry]")) return;
    // A second finger is a pinch, and a pinch spreads sideways: read as a drag it would turn the
    // page while the owner was only trying to zoom.
    if (pending.current) {
      const held = pending.current;
      if (held.phase === "dragging" && held.corner && held.towards) {
        settleBack(held.corner, held.towards, { x: event.clientX - held.x, y: event.clientY - held.y });
      } else release();
      return;
    }
    if (pendingStep.current) return;
    // A turn still settling is cut short rather than left to clear itself out from under the
    // gesture starting now.
    if (frame.current) rest();

    const start: Pending = {
      pointerId: event.pointerId, phase: "watching",
      x: event.clientX, y: event.clientY, corner: undefined, towards: undefined,
      target: { x: 0, y: 0 }, drawn: { x: 0, y: 0 }
    };
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
        current.towards = dx < 0 ? "next" : "previous";
        current.corner = liftedCorner(pageRect(), { x: current.x, y: current.y }, current.towards);
        setTurn({ corner: current.corner, towards: current.towards });
      }
      moveEvent.preventDefault();
      current.target = { x: dx, y: dy };
      if (current.corner) follow(current.corner);
    };
    /**
     * The one thing that actually stops Safari scrolling.
     *
     * WebKit builds Pointer Events on top of Touch Events, and `preventDefault` on a pointer event
     * does not suppress a scroll -- only a non-passive `touchmove` does. Without this, deviating
     * even slightly from horizontal mid-drag let Safari claim the touch for its own elastic scroll
     * and hand back a `pointercancel`, which cancelled the turn under the finger. Chrome honours the
     * pointer event, which is why this was invisible on Android. Only once the drag is ours: a
     * movement still being judged, or one already given up as a scroll, must scroll as it always did.
     */
    const scrollAway = (touchEvent: TouchEvent) => {
      if (pending.current?.phase === "dragging" && touchEvent.cancelable) touchEvent.preventDefault();
    };
    const finish = (upEvent: PointerEvent, cancelled: boolean) => {
      const current = pending.current;
      if (!current || upEvent.pointerId !== current.pointerId) return;
      if (current.phase !== "dragging" || !current.corner || !current.towards) { release(); return; }
      const corner = current.corner;
      const towards = current.towards;
      // What the finger did decides; where the paper had got to is where the rest of the turn starts
      // from, so it carries on from where it was rather than jumping to catch up. A cancelled
      // pointer reports wherever the platform took it, so the last movement we saw is the honest
      // answer to what the owner asked for.
      const delta = cancelled ? current.target : { x: upEvent.clientX - current.x, y: upEvent.clientY - current.y };
      const from = clampReach(corner, current.drawn, TILT);
      release();
      if (Math.abs(delta.x) >= COMMIT_DISTANCE && (delta.x < 0) === (towards === "next")) {
        sweep(corner, towards, from);
      } else settleBack(corner, towards, from);
    };
    const up = (upEvent: PointerEvent) => finish(upEvent, false);
    const cancel = (cancelEvent: PointerEvent) => finish(cancelEvent, true);
    document.addEventListener("touchmove", scrollAway, { passive: false });
    document.addEventListener("pointermove", move, { passive: false });
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", cancel);
    detach.current = () => {
      document.removeEventListener("touchmove", scrollAway);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", cancel);
    };
  }, [enabled, release, rest, paint, settleBack, sweep]);

  return { containerProps: { onPointerDown }, underRef, flapRef, turn };
}
