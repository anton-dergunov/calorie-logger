import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backendSession, CalorieLoggerApiError, estimateFood, externalFoods, postSync, rejectsStoredToken, unreachableMessage } from "./api";

function response(data: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(status < 400 ? { data } : { error: data }), {
    status,
    headers: { "Content-Type": "application/json" }
  }));
}

describe("Calorie Logger HTTP API", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    backendSession.configure({ baseUrl: "https://calorie-logger.example.test", email: "person@example.test", token: "opaque-token" });
  });

  afterEach(() => {
    vi.useRealTimers();
    backendSession.configure(null);
    vi.unstubAllGlobals();
  });

  const emptyChanges = { foods: [], entries: [], settings: null };
  const request = { schemaVersion: 1, deviceId: "device000000001", since: 4, changes: emptyChanges };

  it("exchanges changes only through the versioned Calorie Logger API", async () => {
    fetchMock.mockImplementationOnce(() => response({ schemaVersion: 1, serverTime: "2026-08-21T09:00:00.000Z", cursor: 9, changes: emptyChanges, rejected: [] }));
    await expect(postSync(request)).resolves.toMatchObject({ cursor: 9 });

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://calorie-logger.example.test/api/calorie-logger/v5/sync");
    expect(url).not.toContain("/api/collections/");
    expect(options.method).toBe("POST");
    expect(new Headers(options.headers).get("Authorization")).toBe("Bearer opaque-token");
    expect(options.cache).toBe("no-store");
    expect(JSON.parse(String(options.body))).toMatchObject({ schemaVersion: 1, since: 4 });
  });

  it("reports unreachable and rejected sessions distinctly", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    await expect(postSync(request)).rejects.toMatchObject({ code: "offline", status: 0 });

    fetchMock.mockImplementationOnce(() => response({ code: "unauthenticated", message: "Sign in to continue." }, 401));
    await expect(postSync(request)).rejects.toEqual(expect.any(CalorieLoggerApiError));
  });

  it("surfaces the version a stale client must update to", async () => {
    fetchMock.mockImplementationOnce(() => response({ code: "schema_version_mismatch", message: "Update the app.", fields: { schemaVersion: 3 } }, 409));

    await expect(postSync(request)).rejects.toMatchObject({
      code: "schema_version_mismatch",
      status: 409,
      fields: { schemaVersion: 3 }
    });
  });

  it("rejects an incompatible sync payload instead of destructuring undefined", async () => {
    fetchMock.mockImplementationOnce(() => response({ cursor: 9 }));

    await expect(postSync(request)).rejects.toMatchObject({
      code: "unsupported_api_contract",
      status: 502,
      message: expect.stringMatching(/current Calorie Logger server package/)
    });
  });

  it("logs in through the Calorie Logger session API and retains no password", async () => {
    backendSession.configure(null);
    fetchMock.mockImplementationOnce(() => response({
      token: "returned-token", user: { id: "user-1", email: "normalized@example.test" }
    }));

    const session = await backendSession.login("https://calorie-logger.example.test/", " normalized@example.test ", "temporary-password");
    expect(session).toEqual({ baseUrl: "https://calorie-logger.example.test", email: "normalized@example.test", token: "returned-token", userId: "user-1" });
    expect(session).not.toHaveProperty("password");
    expect(fetchMock.mock.calls[0][0]).toBe("https://calorie-logger.example.test/api/calorie-logger/v5/session");

    await backendSession.logout();
    expect(backendSession.current()).toBeNull();
  });

  it("tests another server without disturbing the active session", async () => {
    fetchMock.mockImplementationOnce(() => response({ service: "calorie-logger", apiVersion: 5 }));
    await expect(backendSession.health("https://candidate.example.test")).resolves.toBe("https://candidate.example.test");
    expect(backendSession.current()?.token).toBe("opaque-token");
  });

  it("identifies a reachable PocketBase instance without the Calorie Logger hooks", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: {}, message: "File not found.", status: 404 }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    }));

    await expect(backendSession.health("https://candidate.example.test")).rejects.toMatchObject({
      code: "calorie_logger_api_missing",
      status: 404,
      message: expect.stringMatching(/Calorie Logger API v5 is not installed/)
    });
  });

  it("retries retryable Open Food Facts failures after one and five seconds and retains CoFID results", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(window, "setTimeout");
    const generic = {
      id: "cofid:11-005", source: { provider: "cofid", id: "11-005", label: "CoFID 2021", url: "https://www.gov.uk/" },
      name: "Oats", detail: "Rolled oats", photoURL: null, preferredUnit: "g",
      nutritionCandidates: [{ unit: "g", basisAmount: 100, calories: 370, protein: 13, fat: 7, carbs: 62 }]
    };
    const product = {
      id: "openFoodFacts:123", source: { provider: "openFoodFacts", id: "123", label: "Open Food Facts", url: "https://world.openfoodfacts.org/product/123" },
      name: "Oat drink", detail: "123", photoURL: null, preferredUnit: "ml",
      nutritionCandidates: [{ unit: "ml", basisAmount: 100, calories: 40, protein: 1, fat: 1.5, carbs: 6 }]
    };
    const retryable = { source: "openFoodFacts", code: "temporarily_unavailable", message: "Try again.", retryable: true };
    fetchMock
      .mockImplementationOnce(() => response({ results: [generic], errors: [retryable] }))
      .mockImplementationOnce(() => response({ results: [], errors: [retryable] }))
      .mockImplementationOnce(() => response({ results: [product], errors: [] }));

    const pending = externalFoods.search("oats");
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ results: [product, generic], errors: [] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      expect.stringContaining("attempt=0"), expect.stringContaining("attempt=1"), expect.stringContaining("attempt=2")
    ]);
    expect(timeout).toHaveBeenCalledWith(expect.any(Function), 1_000);
    expect(timeout).toHaveBeenCalledWith(expect.any(Function), 5_000);
  });

  it("does not retry valid empty results or non-retryable provider failures", async () => {
    fetchMock.mockImplementationOnce(() => response({ results: [], errors: [] }));
    await expect(externalFoods.search("unknown")).resolves.toEqual({ results: [], errors: [] });
    expect(fetchMock).toHaveBeenCalledOnce();

    fetchMock.mockReset();
    const rateLimited = { source: "openFoodFacts", code: "rate_limited", message: "Try later.", retryable: false };
    fetchMock.mockImplementationOnce(() => response({ results: [], errors: [rateLimited] }));
    await expect(externalFoods.search("oats")).resolves.toEqual({ results: [], errors: [rateLimited] });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("looks up one external food by barcode through the authenticated API", async () => {
    const product = {
      id: "off:5012345678900",
      source: { provider: "openFoodFacts", id: "5012345678900", label: "Open Food Facts", url: "https://world.openfoodfacts.org/product/5012345678900" },
      name: "Oat bar", detail: "40 g · 5012345678900", photoURL: null, preferredUnit: "g",
      nutritionCandidates: [{ unit: "g", basisAmount: 100, calories: 400, protein: 8, fat: 12, carbs: 65 }]
    };
    fetchMock.mockImplementationOnce(() => response(product));

    await expect(externalFoods.lookupBarcode("5012345678900")).resolves.toEqual(product);
    expect(fetchMock.mock.calls[0][0]).toBe("https://calorie-logger.example.test/api/calorie-logger/v5/external-foods/barcode?code=5012345678900");

    fetchMock.mockImplementationOnce(() => response(null));
    await expect(externalFoods.lookupBarcode("00000000")).resolves.toBeNull();
  });

  it("sends a described portion for estimation and normalises what comes back", async () => {
    fetchMock.mockImplementationOnce(() => response({
      recognised: true, name: "Porridge with honey", portion: "1 bowl, about 250 g",
      protein: 13.5, fat: 9.2, carbs: 78.5, confidence: "medium", note: ""
    }));

    await expect(estimateFood({ description: "a bowl of porridge with honey" })).resolves.toEqual({
      recognised: true, name: "Porridge with honey", portion: "1 bowl, about 250 g",
      protein: 13.5, fat: 9.2, carbs: 78.5, confidence: "medium", note: null
    });
    expect(fetchMock.mock.calls[0][0]).toBe("https://calorie-logger.example.test/api/calorie-logger/v5/food-estimate");
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(request.method).toBe("POST");
    expect(JSON.parse(String(request.body))).toEqual({ description: "a bowl of porridge with honey" });
  });

  it("sends a photograph, and the typed description with it", async () => {
    fetchMock.mockImplementationOnce(() => response({
      recognised: true, name: "Rice and curry", portion: "1 plate, about 400 g",
      protein: 18, fat: 22, carbs: 96, confidence: "medium", note: ""
    }));

    await estimateFood({ description: "moderate portion", image: { mimeType: "image/jpeg", data: "QUJD" } });
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      description: "moderate portion",
      image: { mimeType: "image/jpeg", data: "QUJD" }
    });
  });

  it("reports an estimator the server cannot reach as its own condition", async () => {
    fetchMock.mockImplementationOnce(() => response({ code: "estimator_unavailable", message: "This server has no food estimator configured." }, 424));

    await expect(estimateFood({ description: "chips" })).rejects.toMatchObject({
      code: "estimator_unavailable",
      status: 424,
      message: "This server has no food estimator configured."
    });
  });

  it("rejects an incompatible search contract instead of dereferencing missing results", async () => {
    fetchMock.mockImplementationOnce(() => response({ groups: [] }));

    await expect(externalFoods.search("oats")).rejects.toMatchObject({
      code: "unsupported_api_contract",
      status: 502,
      message: expect.stringMatching(/current Calorie Logger server package/)
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("restores the stored session without any network work", async () => {
    // Opening the app must not wait on a server. A phone with a VPN interface configured and no
    // connectivity can leave a request outstanding indefinitely, which used to hold the app on
    // its loading screen for as long as that took.
    fetchMock.mockImplementation(() => new Promise(() => undefined));

    await expect(backendSession.restore()).resolves.toMatchObject({ token: "test-token" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives up on a request that never answers instead of waiting forever", () => {
    const [, options] = (() => {
      fetchMock.mockImplementationOnce(() => response({ schemaVersion: 1, serverTime: "", cursor: 0, changes: emptyChanges, rejected: [] }));
      void postSync(request);
      return fetchMock.mock.calls[0] as [string, RequestInit];
    })();

    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("keeps a stored session when the server cannot be reached, and clears it only on rejection", () => {
    expect(rejectsStoredToken(new CalorieLoggerApiError("Unavailable.", 0, "offline"))).toBe(false);
    expect(rejectsStoredToken(new CalorieLoggerApiError("Server error.", 500, "server_error"))).toBe(false);
    expect(rejectsStoredToken(new TypeError("Failed to fetch"))).toBe(false);
    expect(rejectsStoredToken(new CalorieLoggerApiError("Sign in.", 401, "unauthenticated"))).toBe(true);
  });
});

describe("unreachable servers", () => {
  it("says what could not be reached and what usually explains it", () => {
    const timeout = new DOMException("timed out", "TimeoutError");
    expect(unreachableMessage("https://home.example.ts.net", timeout)).toContain("Tailscale is connected on this device");
    expect(unreachableMessage("https://home.example.ts.net", timeout)).toContain("home.example.ts.net");
    expect(unreachableMessage("http://192.168.10.20:8090", new TypeError("failed"))).toContain("only works on that local network");
    expect(unreachableMessage("https://calorie.example.com", new TypeError("failed"))).toContain("Check that the server is running");

    // A device with no connection at all should not be told to check its VPN.
    const online = Object.getOwnPropertyDescriptor(navigator, "onLine");
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    expect(unreachableMessage("https://home.example.ts.net", timeout)).toContain("This device is offline");
    if (online) Object.defineProperty(navigator, "onLine", online);
  });
});
