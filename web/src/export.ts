import type { ExportDocument, ExportRequest, ExportResult } from "./types";

function filename(request: ExportRequest): string {
  return request.scope === "all"
    ? "calorie-logger-export.json"
    : `calorie-log-${request.startDate}-to-${request.endDate}.json`;
}

export async function saveExportDocument(document: ExportDocument, request: ExportRequest): Promise<ExportResult> {
  const name = filename(request);
  const json = JSON.stringify(document, null, 2);
  const native = window.webkit?.messageHandlers?.calorieLogger;
  if (native) {
    const response = await native.postMessage({ method: "saveExport", payload: { filename: name, json } }) as { data?: ExportResult; error?: string };
    if (response.error) throw new Error(response.error);
    return response.data as ExportResult;
  }
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const link = window.document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
  return { status: "saved" };
}
