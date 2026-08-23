import { normalizeServerURL, serverHost, serverReach, sessionStore, type SessionUser, type StoredSession } from "./session";
import type { ExternalFoodResult, ExternalFoodSearchResponse, FoodEstimate, FoodEstimateRequest, SyncChanges, SyncResponse } from "./types";

export class CalorieLoggerApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly fields?: Record<string, unknown>) {
    super(message);
  }
}

const REQUEST_TIMEOUT = 15_000;
// External-catalogue search waits on Open Food Facts, which the server gives eight seconds per
// attempt. Aborting this request at the ordinary budget threw away the CoFID results the server
// had already found alongside it, so the owner saw an error instead of the generic foods.
const SEARCH_TIMEOUT = 25_000;
const ESTIMATE_IMAGE_TIMEOUT = 60_000;

function timeoutSignal(milliseconds: number): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
    ? AbortSignal.timeout(milliseconds)
    : undefined;
}

type Envelope<T> = { data?: T; error?: { code?: string; message?: string; fields?: Record<string, unknown> } };
type LoginResponse = { token: string; user: SessionUser };
const API_VERSION = 5;
const API_PATH = `/api/calorie-logger/v${API_VERSION}`;

function externalFoodSearchResponse(value: unknown): ExternalFoodSearchResponse {
  if (!value || typeof value !== "object") throw incompatibleExternalFoodResponse();
  const candidate = value as Partial<ExternalFoodSearchResponse>;
  if (!Array.isArray(candidate.results) || !Array.isArray(candidate.errors)) throw incompatibleExternalFoodResponse();
  return candidate as ExternalFoodSearchResponse;
}

function incompatibleExternalFoodResponse() {
  return new CalorieLoggerApiError(
    "The server returned an incompatible food-search response. Deploy the current Calorie Logger server package and try again.",
    502,
    "unsupported_api_contract"
  );
}

function foodEstimate(value: unknown): FoodEstimate {
  const candidate = value as Partial<FoodEstimate> | null;
  if (!candidate || typeof candidate.recognised !== "boolean"
    || typeof candidate.protein !== "number" || typeof candidate.fat !== "number" || typeof candidate.carbs !== "number") {
    throw new CalorieLoggerApiError(
      "The server returned an incompatible estimate. Deploy the current Calorie Logger server package and try again.",
      502,
      "unsupported_api_contract"
    );
  }
  return {
    recognised: candidate.recognised,
    name: String(candidate.name ?? ""),
    portion: String(candidate.portion ?? ""),
    protein: candidate.protein,
    fat: candidate.fat,
    carbs: candidate.carbs,
    confidence: candidate.confidence === "high" || candidate.confidence === "medium" ? candidate.confidence : "low",
    note: candidate.note ? String(candidate.note) : null
  };
}

function syncResponse(value: unknown): SyncResponse {
  const candidate = value as Partial<SyncResponse> | null;
  const changes = candidate?.changes;
  if (!candidate || typeof candidate.cursor !== "number" || !changes || !Array.isArray(changes.foods) || !Array.isArray(changes.entries)) {
    throw new CalorieLoggerApiError(
      "The server returned an incompatible sync response. Deploy the current Calorie Logger server package and reconnect.",
      502,
      "unsupported_api_contract"
    );
  }
  return { ...candidate, rejected: candidate.rejected ?? [] } as SyncResponse;
}

/**
 * Why a request never reached the server, in the owner's terms.
 *
 * "Check your connection" is useless advice when the rest of the internet works and the one thing
 * that is down is the tunnel to a private server. The address itself says a great deal: a
 * Tailscale or private address that times out is almost always a VPN that is not connected, and
 * that is worth saying outright rather than making the owner guess.
 */
export function unreachableMessage(baseUrl: string, error: unknown): string {
  const host = serverHost(baseUrl);
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return `This device is offline, so ${host} cannot be reached. Your log is saved here and uploads when you are back online.`;
  }
  const reach = serverReach(baseUrl);
  const timedOut = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
  const gaveUp = timedOut ? `${host} did not answer in time` : `${host} could not be reached`;
  if (reach === "tailscale") {
    return `${gaveUp}. This is a Tailscale address, so check that Tailscale is connected on this device and that the server is online.`;
  }
  if (reach === "private") {
    return `${gaveUp}. This address only works on that local network, so connect to its Wi-Fi or your VPN, or use the address that works from anywhere.`;
  }
  if (reach === "local") {
    return `${gaveUp}. Check that the local Calorie Logger server is running.`;
  }
  return `${gaveUp}. Check that the server is running and that this device has a working connection.`;
}

class CalorieLoggerApiClient {
  private session: StoredSession | null = null;
  private unauthorizedHandler?: () => void;

  configure(session: StoredSession | null, onUnauthorized?: () => void) {
    this.session = session;
    this.unauthorizedHandler = onUnauthorized;
  }

  /** Swaps in a renewed token without disturbing the installed sign-out handler. */
  adopt(session: StoredSession) {
    this.session = session;
  }

  currentSession() { return this.session; }

  async call<T>(path: string, options: RequestInit = {}, anonymous = false, timeout = REQUEST_TIMEOUT): Promise<T> {
    if (!this.session && !anonymous) throw new CalorieLoggerApiError("Sign in to continue.", 401, "unauthenticated");
    const baseUrl = this.session?.baseUrl;
    if (!baseUrl) throw new CalorieLoggerApiError("Configure the Calorie Logger server first.", 0, "not_configured");
    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json");
    if (options.body) headers.set("Content-Type", "application/json");
    if (!anonymous && this.session?.token) headers.set("Authorization", `Bearer ${this.session.token}`);
    let response: Response;
    try { response = await fetch(`${baseUrl}${API_PATH}${path}`, { ...options, headers, cache: "no-store", signal: timeoutSignal(timeout) }); }
    catch (error) { throw new CalorieLoggerApiError(unreachableMessage(baseUrl, error), 0, "offline"); }
    let envelope: Envelope<T> = {};
    try { envelope = await response.json() as Envelope<T>; } catch { /* handled below */ }
    if (!response.ok || envelope.error) {
      const error = new CalorieLoggerApiError(
        envelope.error?.message || "The Calorie Logger server returned an invalid response.",
        response.status,
        envelope.error?.code || "request_failed",
        envelope.error?.fields
      );
      if (response.status === 401 && !anonymous) this.unauthorizedHandler?.();
      throw error;
    }
    return envelope.data as T;
  }
}

const client = new CalorieLoggerApiClient();

/**
 * Whether a failed session refresh means the stored token is genuinely no longer valid.
 *
 * Only a server that answers and rejects the token qualifies. Anything else — no network, a
 * server that is down, a proxy returning nonsense — leaves the token alone, because the owner
 * must be able to open the app and keep logging without a connection.
 */
export function rejectsStoredToken(error: unknown): boolean {
  return error instanceof CalorieLoggerApiError && error.status === 401;
}

export const externalFoods = {
  async search(query: string): Promise<ExternalFoodSearchResponse> {
    let cofidResults: ExternalFoodSearchResponse["results"] = [];
    let response: ExternalFoodSearchResponse = { results: [], errors: [] };
    const delays = [0, 1_000, 5_000];
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      if (delays[attempt]) await new Promise((resolve) => window.setTimeout(resolve, delays[attempt]));
      response = externalFoodSearchResponse(await client.call<unknown>(`/external-foods?query=${encodeURIComponent(query)}&attempt=${attempt}`, {}, false, SEARCH_TIMEOUT));
      if (attempt === 0) cofidResults = response.results.filter((result) => result.source.provider === "cofid");
      const openFoodFactsError = response.errors.find((error) => error.source === "openFoodFacts");
      if (!openFoodFactsError?.retryable) break;
    }
    return {
      results: [...response.results.filter((result) => result.source.provider === "openFoodFacts"), ...cofidResults],
      errors: response.errors
    };
  },
  lookupBarcode: (barcode: string) => client.call<ExternalFoodResult | null>(`/external-foods/barcode?code=${encodeURIComponent(barcode)}`)
};

/**
 * Nutrition for a portion described in words, photographed, or both.
 *
 * The waiting budget is generous for the same reason the search's is: the server gives the model
 * its own timeout and may try again, and aborting sooner would discard an answer it already has.
 * A photograph takes materially longer to read than a sentence, so it is given longer still.
 */
export async function estimateFood(request: FoodEstimateRequest): Promise<FoodEstimate> {
  return foodEstimate(await client.call<unknown>("/food-estimate", {
    method: "POST",
    body: JSON.stringify(request)
  }, false, request.image ? ESTIMATE_IMAGE_TIMEOUT : SEARCH_TIMEOUT));
}

export interface MacReleaseInfo {
  version: string;
  build: string;
  file: string;
  size: number;
  sha256: string;
  /** Server-relative; join it to the server's origin to download. */
  url: string;
}

/**
 * The desktop application this server is offering, or null when it has never published one.
 *
 * Anonymous, because the archive is served by a plain download link that cannot carry a token,
 * and because knowing that a Mac application exists is not private information.
 */
export async function macRelease(): Promise<MacReleaseInfo | null> {
  const release = await client.call<MacReleaseInfo | null>("/mac-release", {}, true);
  return release && release.file ? release : null;
}

/** The absolute address of a server-relative download path. */
export function serverDownloadURL(path: string): string | undefined {
  const baseUrl = client.currentSession()?.baseUrl;
  if (!baseUrl) return undefined;
  return `${baseUrl}${path}`;
}

export async function postSync(request: { schemaVersion: number; deviceId: string; since: number; changes: SyncChanges }): Promise<SyncResponse> {
  return syncResponse(await client.call<unknown>("/sync", { method: "POST", body: JSON.stringify(request) }));
}

export const backendSession = {
  configure(session: StoredSession | null, onUnauthorized?: () => void) { client.configure(session, onUnauthorized); },
  current() { return client.currentSession(); },

  /**
   * Restores the stored session from this device alone.
   *
   * Deliberately does no network work. Opening the app used to wait on a token refresh, so a
   * phone with no route to the server sat on the loading screen for as long as the request took
   * to give up -- which, with a VPN interface configured and no connectivity, can be forever.
   */
  async restore(): Promise<StoredSession | null> {
    const stored = await sessionStore.load();
    if (!stored) return null;
    if (stored.token) client.configure(stored);
    return stored;
  },

  /**
   * Extends the stored token, after the app is already usable.
   *
   * Failure is not an error the owner has to see: only a server that answers and rejects the
   * token signs them out. Anything else means the current token stays and is tried again later.
   */
  async refresh(): Promise<StoredSession | null> {
    const stored = client.currentSession();
    if (!stored?.token || import.meta.env.MODE === "test") return stored ?? null;
    try {
      const refreshed = await client.call<LoginResponse>("/session/refresh", { method: "POST" });
      const session = { ...stored, email: refreshed.user.email, token: refreshed.token, userId: refreshed.user.id };
      await sessionStore.save(session);
      client.adopt(session);
      return session;
    } catch (error) {
      if (!rejectsStoredToken(error)) return stored;
      return null;
    }
  },

  async health(rawUrl: string): Promise<string> {
    const baseUrl = normalizeServerURL(rawUrl);
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${API_PATH}/health`, { headers: { Accept: "application/json" }, cache: "no-store", signal: timeoutSignal(REQUEST_TIMEOUT) });
    } catch (error) {
      throw new CalorieLoggerApiError(unreachableMessage(baseUrl, error), 0, "offline");
    }
    let envelope: Envelope<{ service: string; apiVersion: number }> = {};
    try { envelope = await response.json() as Envelope<{ service: string; apiVersion: number }>; } catch { /* diagnosed below */ }
    if (response.status === 404) {
      throw new CalorieLoggerApiError(`The server is reachable, but Calorie Logger API v${API_VERSION} is not installed. Deploy the current pb_hooks and pb_migrations, then restart PocketBase.`, 404, "calorie_logger_api_missing");
    }
    if (!response.ok || envelope.error || !envelope.data) {
      throw new CalorieLoggerApiError(envelope.error?.message || "The server is reachable but did not return a valid Calorie Logger health response.", response.status, envelope.error?.code || "invalid_health_response");
    }
    const result = envelope.data;
    if (result.service !== "calorie-logger" || result.apiVersion !== API_VERSION) {
      throw new CalorieLoggerApiError("This server does not provide the supported Calorie Logger API version.", response.status, "unsupported_api");
    }
    return baseUrl;
  },

  async login(rawUrl: string, email: string, password: string): Promise<StoredSession> {
    const baseUrl = normalizeServerURL(rawUrl);
    client.configure({ baseUrl, email: email.trim(), token: "" });
    try {
      const result = await client.call<LoginResponse>("/session", { method: "POST", body: JSON.stringify({ email: email.trim(), password }) }, true);
      const session = { baseUrl, email: result.user.email, token: result.token, userId: result.user.id };
      await sessionStore.save(session);
      client.configure(session);
      return session;
    } catch (error) { client.configure(null); throw error; }
  },

  async logout() { client.configure(null); await sessionStore.clear(); },

  async reject() {
    const stored = client.currentSession();
    client.configure(null);
    if (stored) await sessionStore.forgetToken(stored);
  }
};
