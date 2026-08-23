import { afterEach, describe, expect, it, vi } from "vitest";

const { readBarcodes, prepareZXingModule } = vi.hoisted(() => ({
  readBarcodes: vi.fn(),
  prepareZXingModule: vi.fn()
}));
vi.mock("zxing-wasm/reader", () => ({ readBarcodes, prepareZXingModule }));

import { cameraAvailable, createBarcodeDecoder, stopCamera, validRetailBarcode } from "./barcodeDetection";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  readBarcodes.mockReset();
  prepareZXingModule.mockClear();
  delete (window as typeof window & { BarcodeDetector?: unknown }).BarcodeDetector;
});

describe("barcode detection", () => {
  it("reports camera availability from enumerated video inputs", async () => {
    vi.stubGlobal("navigator", { mediaDevices: {
      getUserMedia: vi.fn(),
      enumerateDevices: vi.fn().mockResolvedValue([{ kind: "audioinput" }, { kind: "videoinput" }])
    } });
    await expect(cameraAvailable()).resolves.toBe(true);
  });

  it("accepts supported retail barcode lengths only", () => {
    expect(validRetailBarcode("12345678")).toBe(true);
    expect(validRetailBarcode("123456789012")).toBe(true);
    expect(validRetailBarcode("1234567890123")).toBe(true);
    expect(validRetailBarcode("12345678901234")).toBe(true);
    expect(validRetailBarcode("1234")).toBe(false);
    expect(validRetailBarcode("1234567A")).toBe(false);
  });

  it("prefers a native detector that supports every retail format", async () => {
    const detect = vi.fn().mockResolvedValue([{ rawValue: "5012345678900" }]);
    class Detector {
      static getSupportedFormats = vi.fn().mockResolvedValue(["ean_13", "ean_8", "upc_a", "upc_e"]);
      detect = detect;
    }
    (window as typeof window & { BarcodeDetector?: unknown }).BarcodeDetector = Detector;
    const decoder = await createBarcodeDecoder();
    await expect(decoder.detect(document.createElement("video"), document.createElement("canvas"))).resolves.toBe("5012345678900");
    expect(detect).toHaveBeenCalledOnce();
    expect(readBarcodes).not.toHaveBeenCalled();
  });

  it("uses the local WASM reader when native retail detection is unavailable", async () => {
    readBarcodes.mockResolvedValue([{ text: "5012345678900" }]);
    const video = document.createElement("video");
    Object.defineProperties(video, { videoWidth: { value: 1280 }, videoHeight: { value: 720 } });
    const canvas = document.createElement("canvas");
    const image = { data: new Uint8ClampedArray(4), width: 1, height: 1 };
    vi.spyOn(canvas, "getContext").mockReturnValue({ drawImage: vi.fn(), getImageData: vi.fn().mockReturnValue(image) } as unknown as CanvasRenderingContext2D);

    const decoder = await createBarcodeDecoder();
    await expect(decoder.detect(video, canvas)).resolves.toBe("5012345678900");
    expect(prepareZXingModule).toHaveBeenCalled();
    expect(readBarcodes).toHaveBeenCalledWith(image, expect.objectContaining({
      formats: ["EAN13", "EAN8", "UPCA", "UPCE"], maxNumberOfSymbols: 1
    }));
  });

  it("stops every track in a released camera stream", () => {
    const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
    stopCamera({ getTracks: () => tracks } as unknown as MediaStream);
    expect(tracks.every((track) => track.stop.mock.calls.length === 1)).toBe(true);
  });
});
