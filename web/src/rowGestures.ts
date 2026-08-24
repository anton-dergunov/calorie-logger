import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from "react";

/**
 * One press on a log row has to become exactly one of four things, and the rule cannot be the same
 * for a mouse and for a finger.
 *
 * A mouse never scrolls a list by dragging it, so movement is a safe discriminator and the browser's
 * own drag-and-drop threshold already applies it: a mouse drag is left to `dragstart`, which is why
 * nothing here listens for mouse movement.
 *
 * A finger, though, scrolls the page by moving, so movement cannot mean "drag". Time does. Holding
 * still lifts the row; moving sideways opens its actions; moving any other way is the scroll the
 * page was always going to do; releasing early is a tap, and taps edit. Because the lift demands
 * stillness, the scroller has not claimed the touch by the time we take it, which is what makes
 * calling `preventDefault` on the later moves work at all.
 */
const HOLD_MS = 400;
/** Movement allowed during the hold. Fingers are never perfectly still. */
const HOLD_DRIFT = 8;
/** Sideways movement that commits to a swipe rather than a scroll. */
const SWIPE_START = 12;
/** Share of the revealed width that has to be crossed for the actions to stay open. */
const SWIPE_COMMIT = 0.4;

/** A device we should offer a context menu and native drag to. Assumed when the query is unanswerable. */
export function hasFinePointer(): boolean {
  return !window.matchMedia?.("(pointer: coarse)").matches;
}

type Phase = "waiting" | "swiping" | "taken";

interface Pending {
  id: string;
  pointerId: number;
  phase: Phase;
  x: number;
  y: number;
  base: number;
  timer: number | undefined;
}

export interface RowGestureOptions {
  /** False while another mode owns the rows, which stands every gesture down. */
  enabled: boolean;
  /** False while reordering, when a swipe would fight the drag. */
  swipeEnabled: boolean;
  /** How far a row slides to uncover its actions. */
  actionsWidth: number;
  onLift(id: string): void;
  onMenu(id: string, position: { x: number; y: number }): void;
}

export interface RowGestures {
  rowProps(id: string): {
    onPointerDown(event: ReactPointerEvent): void;
    onContextMenu(event: ReactMouseEvent): void;
  };
  /** The row following the finger, and how far it has slid. Negative is leftwards. */
  sliding: { id: string; offset: number } | null;
  /** The row whose actions are uncovered. */
  revealed: string | undefined;
  closeReveal(): void;
  /** True when the click that follows belongs to a gesture and must not open the editor. */
  claimedClick(): boolean;
}

export function useRowGestures({ enabled, swipeEnabled, actionsWidth, onLift, onMenu }: RowGestureOptions): RowGestures {
  const pending = useRef<Pending | null>(null);
  const detach = useRef<(() => void) | undefined>(undefined);
  const lastPointerType = useRef("mouse");
  const claimed = useRef(0);
  const [sliding, setSliding] = useState<{ id: string; offset: number } | null>(null);
  const [revealed, setRevealed] = useState<string>();

  const settle = useCallback(() => {
    if (pending.current?.timer) window.clearTimeout(pending.current.timer);
    pending.current = null;
    detach.current?.();
    detach.current = undefined;
    setSliding(null);
  }, []);

  const closeReveal = useCallback(() => { setRevealed(undefined); settle(); }, [settle]);

  useEffect(() => settle, [settle]);
  useEffect(() => { if (!enabled || !swipeEnabled) closeReveal(); }, [enabled, swipeEnabled, closeReveal]);

  // Anything else the owner does puts the actions away: a scroll, or a press somewhere off the row.
  useEffect(() => {
    if (!revealed) return;
    const away = (event: Event) => {
      const row = (event.target as HTMLElement | null)?.closest?.<HTMLElement>("[data-drop-entry]");
      if (row?.dataset.dropEntry !== revealed) setRevealed(undefined);
    };
    const scrolled = () => setRevealed(undefined);
    document.addEventListener("pointerdown", away);
    window.addEventListener("scroll", scrolled, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", away);
      window.removeEventListener("scroll", scrolled);
    };
  }, [revealed]);

  const onPointerDown = useCallback((id: string, event: ReactPointerEvent) => {
    lastPointerType.current = event.pointerType;
    if (!enabled || event.pointerType === "mouse" || event.button !== 0) return;
    settle();
    const start: Pending = {
      id, pointerId: event.pointerId, phase: "waiting",
      x: event.clientX, y: event.clientY,
      base: revealed === id ? -actionsWidth : 0,
      timer: window.setTimeout(() => {
        if (pending.current?.phase !== "waiting") return;
        pending.current.phase = "taken";
        claimed.current = Date.now();
        setRevealed(undefined);
        onLift(id);
        settle();
      }, HOLD_MS)
    };
    pending.current = start;

    const move = (moveEvent: PointerEvent) => {
      const current = pending.current;
      if (!current || moveEvent.pointerId !== current.pointerId) return;
      const dx = moveEvent.clientX - current.x;
      const dy = moveEvent.clientY - current.y;
      if (current.phase === "waiting") {
        if (swipeEnabled && Math.abs(dx) > SWIPE_START && Math.abs(dx) > Math.abs(dy)) {
          window.clearTimeout(current.timer);
          current.timer = undefined;
          current.phase = "swiping";
        } else if (Math.abs(dx) > HOLD_DRIFT || Math.abs(dy) > HOLD_DRIFT) {
          // The page is scrolling. Let it, and take nothing.
          settle();
          return;
        }
      }
      if (current.phase !== "swiping") return;
      moveEvent.preventDefault();
      setSliding({ id: current.id, offset: Math.min(0, Math.max(-actionsWidth - 24, current.base + dx)) });
    };
    const up = (upEvent: PointerEvent) => {
      const current = pending.current;
      if (!current || upEvent.pointerId !== current.pointerId) return;
      if (current.phase === "swiping") {
        const offset = Math.min(0, Math.max(-actionsWidth - 24, current.base + (upEvent.clientX - current.x)));
        setRevealed(offset < -actionsWidth * SWIPE_COMMIT ? current.id : undefined);
        claimed.current = Date.now();
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
  }, [enabled, swipeEnabled, actionsWidth, revealed, onLift, settle]);

  const onContextMenu = useCallback((id: string, event: ReactMouseEvent) => {
    // Android raises this in the middle of a hold, where it would cover the row being lifted.
    event.preventDefault();
    if (!enabled || lastPointerType.current !== "mouse") return;
    setRevealed(undefined);
    onMenu(id, { x: event.clientX, y: event.clientY });
  }, [enabled, onMenu]);

  const rowProps = useCallback((id: string) => ({
    onPointerDown: (event: ReactPointerEvent) => onPointerDown(id, event),
    onContextMenu: (event: ReactMouseEvent) => onContextMenu(id, event)
  }), [onPointerDown, onContextMenu]);

  return {
    rowProps, sliding, revealed, closeReveal,
    claimedClick: () => Date.now() - claimed.current < HOLD_MS
  };
}
