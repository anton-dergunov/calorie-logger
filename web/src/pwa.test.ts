import { afterEach, describe, expect, it } from "vitest";
import { detectedInstallPlatform, shouldOfferMacApplication, shouldOfferMobileInstall } from "./pwa";

// jsdom keeps these on Navigator.prototype and does not define maxTouchPoints at all, so own
// properties are defined on the instance to shadow them and deleted again afterwards.
function pretend(userAgent: string, platform: string, maxTouchPoints = 0) {
  const values: Record<string, unknown> = { userAgent, platform, maxTouchPoints };
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(navigator, name, { value, configurable: true });
  }
}

afterEach(() => {
  for (const name of ["userAgent", "platform", "maxTouchPoints"]) {
    delete (navigator as unknown as Record<string, unknown>)[name];
  }
  delete (window as { webkit?: unknown }).webkit;
});

describe("detectedInstallPlatform", () => {
  it("recognises the platforms that have something to install", () => {
    pretend("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", "iPhone");
    expect(detectedInstallPlatform()).toBe("ios");

    pretend("Mozilla/5.0 (Linux; Android 14; Pixel 8)", "Linux armv8l");
    expect(detectedInstallPlatform()).toBe("android");

    pretend("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel");
    expect(detectedInstallPlatform()).toBe("macos");

    pretend("Mozilla/5.0 (X11; Linux x86_64)", "Linux x86_64");
    expect(detectedInstallPlatform()).toBe("other");
  });

  it("reads an iPad asking for the desktop site as an iPad", () => {
    // Safari on iPadOS reports itself as a Mac. Touch points are the only difference, and getting
    // this wrong would offer the Mac application to someone holding a tablet.
    pretend("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel", 5);
    expect(detectedInstallPlatform()).toBe("ios");
  });
});

describe("what each platform is offered", () => {
  it("gates only phones and tablets on installing, never desktops", () => {
    pretend("Mozilla/5.0 (Linux; Android 14; Pixel 8)", "Linux armv8l");
    expect(shouldOfferMobileInstall()).toBe(true);
    expect(shouldOfferMacApplication()).toBe(false);

    pretend("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel");
    expect(shouldOfferMobileInstall()).toBe(false);
    expect(shouldOfferMacApplication()).toBe(true);
  });

  it("does not offer the Mac application to the Mac application", () => {
    pretend("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel");
    (window as { webkit?: unknown }).webkit = { messageHandlers: { calorieLogger: {} } };
    expect(shouldOfferMacApplication()).toBe(false);
  });
});
