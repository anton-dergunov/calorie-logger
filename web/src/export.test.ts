import { afterEach, describe, expect, it, vi } from "vitest";
import { saveExportDocument } from "./export";
import type { ExportDocument } from "./types";

const document: ExportDocument = {
  schemaVersion: 4,
  exportedAt: "2026-08-20T12:00:00Z",
  scope: "all",
  targets: { calories: null, protein: null, fat: null, carbs: null },
  foods: [],
  entries: []
};

describe("export destination", () => {
  afterEach(() => {
    delete window.webkit;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses the native save bridge in the macOS host", async () => {
    const postMessage = vi.fn().mockResolvedValue({ data: { status: "saved", path: "/tmp/export.json" } });
    window.webkit = { messageHandlers: { calorieLogger: { postMessage } } };

    await expect(saveExportDocument(document, { scope: "all" })).resolves.toMatchObject({ status: "saved" });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ method: "saveExport" }));
  });

  it("downloads JSON directly in a browser", async () => {
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:calorie-logger"), revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    await saveExportDocument(document, { scope: "range", startDate: "2026-08-01", endDate: "2026-08-20" });
    expect(click).toHaveBeenCalledOnce();
  });
});
