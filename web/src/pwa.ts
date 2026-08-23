import { registerSW } from "virtual:pwa-register";

let installPrompt: BeforeInstallPromptEvent | undefined;

const UPDATE_CHECK_INTERVAL = 60 * 60 * 1000;

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type InstallPlatform = "ios" | "android" | "macos" | "other";

export function detectedInstallPlatform(): InstallPlatform {
  const userAgent = navigator.userAgent || "";
  // An iPad asking for the desktop site claims to be a Mac, and the touch points are the only
  // thing that separates the two. The check has to come before the macOS one for that reason.
  const isIPadDesktopMode = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  if (/iPad|iPhone|iPod/i.test(userAgent) || isIPadDesktopMode) return "ios";
  if (/Android/i.test(userAgent)) return "android";
  if (/Mac/i.test(navigator.platform || userAgent)) return "macos";
  return "other";
}

export function isInstalledApp(): boolean {
  return window.matchMedia?.("(display-mode: standalone)").matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true
    || Boolean(window.webkit?.messageHandlers?.calorieLogger);
}

export function shouldOfferMobileInstall(): boolean {
  const platform = detectedInstallPlatform();
  return (platform === "ios" || platform === "android") && !isInstalledApp();
}

/**
 * Whether to offer the desktop application.
 *
 * A full-page gate is right on a phone, where installing is the difference between an app and a
 * browser tab. On a Mac the browser works perfectly well, so the download is offered in Settings
 * and as a banner that can be dismissed for good, never as something to get past.
 */
export function shouldOfferMacApplication(): boolean {
  return detectedInstallPlatform() === "macos" && !isNativeHost();
}

export function isNativeHost(): boolean {
  return Boolean(window.webkit?.messageHandlers?.calorieLogger);
}

/**
 * Whether this browser can see Calorie Logger already installed on the device.
 *
 * Chrome only fires its install event when the app is *not* installed, so the install button
 * simply disappears once it is — which reads as the page having lost the feature. This is the one
 * way a tab can tell the difference; it is unsupported on plenty of browsers, so a false answer
 * means "cannot tell", never "not installed".
 */
export async function alreadyInstalledOnThisDevice(): Promise<boolean> {
  const query = (navigator as Navigator & { getInstalledRelatedApps?: () => Promise<unknown[]> }).getInstalledRelatedApps;
  if (typeof query !== "function") return false;
  try { return (await query.call(navigator)).length > 0; } catch { return false; }
}

export function canPromptInstall(): boolean {
  return Boolean(installPrompt);
}

export async function promptInstall(): Promise<boolean> {
  if (!installPrompt) return false;
  const prompt = installPrompt;
  await prompt.prompt();
  const choice = await prompt.userChoice;
  installPrompt = undefined;
  return choice.outcome === "accepted";
}

/**
 * How far along a waiting update is.
 *
 * The application used to install an update invisibly and then reload itself mid-sentence. It now
 * says what is happening: the shell is a few megabytes of artwork and a WebAssembly reader, so the
 * download is long enough on a phone to be worth naming, and the reload only happens when asked.
 */
export type UpdateStage = "downloading" | "ready";

export const UPDATE_EVENT = "calorie-logger-update";

let applyUpdate: ((reload: boolean) => Promise<void>) | undefined;
let currentStage: UpdateStage | undefined;

export function updateStage(): UpdateStage | undefined {
  return currentStage;
}

function announce(stage: UpdateStage | undefined) {
  currentStage = stage;
  window.dispatchEvent(new CustomEvent(UPDATE_EVENT, { detail: stage }));
}

/** Applies the waiting update and reloads. Resolves to false when there was nothing waiting. */
export async function installUpdate(): Promise<boolean> {
  if (!applyUpdate) return false;
  await applyUpdate(true);
  return true;
}

/**
 * A worker that is already installing when the page loads, or one that starts later. Watching the
 * `installing` worker is the only way to distinguish "downloading the update" from "ready", and
 * without it the app would sit silent through the part that actually takes time.
 */
function watchInstallation(registration: ServiceWorkerRegistration) {
  const observe = (worker: ServiceWorker | null) => {
    if (!worker) return;
    // A first-ever install has nothing to replace, so it is not an update and must not be
    // announced as one.
    if (!navigator.serviceWorker.controller) return;
    announce("downloading");
    worker.addEventListener("statechange", () => {
      if (worker.state === "installed") announce("ready");
      if (worker.state === "redundant") announce(undefined);
    });
  };
  observe(registration.installing);
  registration.addEventListener("updatefound", () => observe(registration.installing));
}

export function registerCalorieLoggerServiceWorker() {
  if (!(location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) return;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event as BeforeInstallPromptEvent;
    window.dispatchEvent(new CustomEvent("calorie-logger-install-available"));
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = undefined;
    window.dispatchEvent(new CustomEvent("calorie-logger-installed"));
  });
  applyUpdate = registerSW({
    immediate: true,
    onNeedRefresh: () => announce("ready"),
    onRegisteredSW: (_url, registration) => {
      if (!registration) return;
      watchInstallation(registration);
      if (registration.waiting && navigator.serviceWorker.controller) announce("ready");
      // The browser re-checks the worker on its own roughly once a day, which is long enough for
      // a device to sit on a build the server has already replaced. Checking when the app is
      // brought back to the front, and hourly while it is open, keeps that to minutes.
      const check = () => { registration.update().catch(() => undefined); };
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") check();
      });
      window.setInterval(check, UPDATE_CHECK_INTERVAL);
    },
    onRegisterError: (error) => console.warn("Calorie Logger service worker registration failed", error)
  });
}
