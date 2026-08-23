import { describe, expect, it } from "vitest";
import { normalizeServerURL , serverHost, serverReach } from "./session";

describe("normalizeServerURL", () => {
  it("normalizes secure server addresses", () => {
    expect(normalizeServerURL("  https://calorie-logger.example.test/base/  ")).toBe("https://calorie-logger.example.test/base");
  });

  it("accepts a pasted Calorie Logger API endpoint and stores only its server base URL", () => {
    expect(normalizeServerURL("https://calorie-logger.example.test:8091/api/calorie-logger/v5/"))
      .toBe("https://calorie-logger.example.test:8091");
    expect(normalizeServerURL("https://calorie-logger.example.test/prefix/api/calorie-logger/v5"))
      .toBe("https://calorie-logger.example.test/prefix");
  });

  it("allows plain HTTP only for loopback development", () => {
    expect(normalizeServerURL("http://localhost:8090/")).toBe("http://localhost:8090");
    expect(normalizeServerURL("http://127.0.0.1:8090")).toBe("http://127.0.0.1:8090");
    expect(() => normalizeServerURL("http://calorie-logger.example.test")).toThrow(/HTTPS/);
  });

  it("rejects credentials and URL decorations", () => {
    expect(() => normalizeServerURL("https://user:secret@calorie-logger.example.test")).toThrow(/base URL/);
    expect(() => normalizeServerURL("https://calorie-logger.example.test/?token=secret")).toThrow(/base URL/);
    expect(() => normalizeServerURL("")).toThrow(/valid server URL/);
  });
});

describe("how a server is reached", () => {
  it("recognises the addresses that only work through a tunnel or a local network", () => {
    expect(serverReach("https://home.example.ts.net")).toBe("tailscale");
    expect(serverReach("http://100.101.102.103:8090")).toBe("tailscale");
    expect(serverReach("http://192.168.10.20:8090")).toBe("private");
    expect(serverReach("http://10.0.0.5")).toBe("private");
    expect(serverReach("http://172.20.0.5")).toBe("private");
    expect(serverReach("http://172.32.0.5")).toBe("public");
    expect(serverReach("http://localhost:8090")).toBe("local");
    expect(serverReach("https://calorie.example.com")).toBe("public");
    expect(serverHost("https://home.example.ts.net/")).toBe("home.example.ts.net");
  });
});
