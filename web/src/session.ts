export interface StoredSession {
  baseUrl: string;
  email: string;
  token: string;
  /** Which account the local replica belongs to. Signing in as someone else replaces it. */
  userId?: string;
}

export interface SessionUser {
  id: string;
  email: string;
}

declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        calorieLogger?: {
          postMessage(message: { method: string; payload: unknown }): Promise<unknown>;
        };
      };
    };
  }
}

const STORAGE_KEY = "calorie-logger.backend.session.v1";

function nativeHandler() {
  return window.webkit?.messageHandlers?.calorieLogger;
}

/** Whether this page is running inside the macOS menu-bar host rather than a browser tab. */
export function isNativeHost(): boolean {
  return !!nativeHandler();
}

async function nativeCall<T>(method: string, payload: unknown = {}): Promise<T> {
  const result = await nativeHandler()!.postMessage({ method, payload }) as { data?: T; error?: string };
  if (result.error) throw new Error(result.error);
  return result.data as T;
}

export function normalizeServerURL(raw: string): string {
  const value = raw.trim().replace(/\/+$/, "");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Enter a valid server URL."); }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("Use an HTTPS server URL. HTTP is allowed only for local development.");
  if (url.username || url.password || url.search || url.hash) throw new Error("Enter only the server base URL.");
  const path = url.pathname.replace(/\/$/, "").replace(/\/api\/calorie-logger\/v\d+$/i, "");
  return url.origin + (path === "/" ? "" : path);
}

/**
 * How a server address is reached, so an unreachable server can say something more useful than
 * "check your connection". A private address is only reachable from inside its own network, and
 * a Tailscale address only while Tailscale is connected on this device — by far the most common
 * reason a sync stops working while the rest of the internet is fine.
 */
export type ServerReach = "tailscale" | "private" | "local" | "public";

export function serverHost(rawUrl: string): string {
  try { return new URL(rawUrl).host; } catch { return rawUrl; }
}

export function serverReach(rawUrl: string): ServerReach {
  let hostname: string;
  try { hostname = new URL(rawUrl).hostname.toLowerCase(); } catch { return "public"; }
  if (hostname.endsWith(".ts.net")) return "tailscale";
  const parts = hostname.split(".").map(Number);
  const isIPv4 = parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return "local";
  if (!isIPv4) return "public";
  // Tailscale hands out addresses from the 100.64.0.0/10 carrier-grade NAT range.
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return "tailscale";
  if (parts[0] === 10) return "private";
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return "private";
  if (parts[0] === 192 && parts[1] === 168) return "private";
  return "public";
}

export const sessionStore = {
  async load(): Promise<StoredSession | null> {
    if (import.meta.env.MODE === "test") return { baseUrl: "https://calorie-logger.test", email: "test@example.invalid", token: "test-token", userId: "test-owner" };
    if (nativeHandler()) return nativeCall<StoredSession | null>("loadSession");
    const value = localStorage.getItem(STORAGE_KEY);
    if (!value) return null;
    try { return JSON.parse(value) as StoredSession; } catch { localStorage.removeItem(STORAGE_KEY); return null; }
  },
  async save(session: StoredSession): Promise<void> {
    if (import.meta.env.MODE === "test") return;
    if (nativeHandler()) await nativeCall("saveSession", { session });
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  },
  async clear(): Promise<void> {
    if (import.meta.env.MODE === "test") return;
    if (nativeHandler()) await nativeCall("clearSession");
    else localStorage.removeItem(STORAGE_KEY);
  },
  async forgetToken(session: StoredSession): Promise<void> {
    const nonSecret = { ...session, token: "" };
    if (import.meta.env.MODE === "test") return;
    if (nativeHandler()) await nativeCall("clearToken");
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(nonSecret));
  }
};
