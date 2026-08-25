/**
 * How much of the window is actually visible, published for the stylesheet to lay dialogs out in.
 *
 * iOS ignores `interactive-widget=resizes-content`: the software keyboard does not shrink the
 * layout viewport, it covers it. A dialog centred in `100vh` therefore has its footer -- the save
 * button, the add button -- underneath the keyboard, and the only way to reach it was to dismiss
 * the keyboard first. The visual viewport is the part still in view, and it is the box every
 * dialog should be measured against.
 *
 * `offsetTop` matters as much as the height: a fixed element is positioned against the layout
 * viewport, so once iOS scrolls the page under the keyboard the two no longer share an origin.
 */
export const VIEWPORT_HEIGHT = "--app-viewport-height";
export const VIEWPORT_TOP = "--app-viewport-top";
/** How much of the window the keyboard is covering, for anything anchored to the bottom. */
export const KEYBOARD_INSET = "--app-keyboard-inset";

export function observeViewport(target: HTMLElement = document.documentElement): () => void {
  const viewport = window.visualViewport;
  let frame = 0;

  const publish = () => {
    frame = 0;
    // Without the API the layout viewport is the best answer there is, and it is the right one
    // everywhere a keyboard does not overlap the page.
    const height = viewport?.height ?? window.innerHeight;
    const top = viewport?.offsetTop ?? 0;
    const covered = Math.max(0, window.innerHeight - (top + height));
    target.style.setProperty(VIEWPORT_HEIGHT, `${Math.round(height)}px`);
    target.style.setProperty(VIEWPORT_TOP, `${Math.round(top)}px`);
    target.style.setProperty(KEYBOARD_INSET, `${Math.round(covered)}px`);
  };

  // A keyboard opening reports continuously as it animates; one write per frame is enough.
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(publish);
  };

  publish();
  viewport?.addEventListener("resize", schedule);
  viewport?.addEventListener("scroll", schedule);
  window.addEventListener("resize", schedule);

  return () => {
    if (frame) cancelAnimationFrame(frame);
    viewport?.removeEventListener("resize", schedule);
    viewport?.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
  };
}
