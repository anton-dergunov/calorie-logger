import { afterEach, describe, expect, it, vi } from "vitest";
import { KEYBOARD_INSET, observeViewport, VIEWPORT_HEIGHT, VIEWPORT_TOP } from "./viewport";

type Listener = () => void;

/** The part of `VisualViewport` this reads, with a way to move it as a keyboard would. */
function stubVisualViewport(height: number, offsetTop = 0) {
  const listeners = new Map<string, Set<Listener>>();
  const viewport = {
    height,
    offsetTop,
    addEventListener(type: string, listener: Listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: Listener) {
      listeners.get(type)?.delete(listener);
    }
  };
  Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true, writable: true });
  return {
    viewport,
    emit(type: string) { listeners.get(type)?.forEach((listener) => listener()); },
    listenerCount() { return [...listeners.values()].reduce((total, set) => total + set.size, 0); }
  };
}

function readVariables() {
  const style = document.documentElement.style;
  return {
    height: style.getPropertyValue(VIEWPORT_HEIGHT),
    top: style.getPropertyValue(VIEWPORT_TOP),
    keyboard: style.getPropertyValue(KEYBOARD_INSET)
  };
}

afterEach(() => {
  Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true, writable: true });
  document.documentElement.removeAttribute("style");
  vi.restoreAllMocks();
});

describe("viewport", () => {
  it("publishes the layout viewport where the visual viewport is not available", () => {
    window.innerHeight = 900;
    const stop = observeViewport();

    expect(readVariables()).toEqual({ height: "900px", top: "0px", keyboard: "0px" });
    stop();
  });

  it("reports the visible box and what the keyboard covers", async () => {
    window.innerHeight = 900;
    const stub = stubVisualViewport(900);
    const stop = observeViewport();
    expect(readVariables()).toEqual({ height: "900px", top: "0px", keyboard: "0px" });

    // A keyboard opens: iOS leaves the layout viewport alone and shrinks the visual one.
    stub.viewport.height = 560;
    stub.emit("resize");
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(readVariables()).toEqual({ height: "560px", top: "0px", keyboard: "340px" });
    stop();
  });

  it("follows the page when the keyboard scrolls it out from under the window", async () => {
    window.innerHeight = 900;
    const stub = stubVisualViewport(560, 0);
    const stop = observeViewport();

    stub.viewport.offsetTop = 120;
    stub.emit("scroll");
    await new Promise((resolve) => requestAnimationFrame(resolve));

    // Fixed elements are positioned against the layout viewport, so a dialog has to be told how
    // far the visible box has moved as well as how tall it is.
    expect(readVariables()).toEqual({ height: "560px", top: "120px", keyboard: "220px" });
    stop();
  });

  it("stops listening once it is torn down", () => {
    const stub = stubVisualViewport(900);
    const stop = observeViewport();
    expect(stub.listenerCount()).toBeGreaterThan(0);

    stop();
    expect(stub.listenerCount()).toBe(0);
  });
});
