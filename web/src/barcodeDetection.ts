import type { ReaderOptions } from "zxing-wasm/reader";
import zxingReaderWasmURL from "zxing-wasm/reader/zxing_reader.wasm?url";

export const RETAIL_BARCODE_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e"] as const;
const ZXING_RETAIL_FORMATS: ReaderOptions["formats"] = ["EAN13", "EAN8", "UPCA", "UPCE"];

type BarcodeImageSource = HTMLVideoElement | HTMLCanvasElement | ImageData;
type DetectedBarcode = { rawValue: string };
type NativeBarcodeDetector = { detect(source: BarcodeImageSource): Promise<DetectedBarcode[]> };
type NativeBarcodeDetectorConstructor = {
  new(options?: { formats?: string[] }): NativeBarcodeDetector;
  getSupportedFormats(): Promise<string[]>;
};

export interface BarcodeDecoder {
  detect(video: HTMLVideoElement, canvas: HTMLCanvasElement): Promise<string | null>;
}

function nativeBarcodeDetector(): NativeBarcodeDetectorConstructor | undefined {
  return (window as typeof window & { BarcodeDetector?: NativeBarcodeDetectorConstructor }).BarcodeDetector;
}

export function validRetailBarcode(value: string): boolean {
  return /^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(value);
}

export async function cameraAvailable(): Promise<boolean> {
  if (!navigator.mediaDevices?.getUserMedia || !navigator.mediaDevices.enumerateDevices) return false;
  try {
    return (await navigator.mediaDevices.enumerateDevices()).some((device) => device.kind === "videoinput");
  } catch {
    return false;
  }
}

export function stopCamera(stream: MediaStream | null | undefined) {
  stream?.getTracks().forEach((track) => track.stop());
}

function canvasFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement, longEdge = 960): ImageData | null {
  if (!video.videoWidth || !video.videoHeight) return null;
  const scale = Math.min(1, longEdge / video.videoWidth);
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

const zxingOverrides = {
  locateFile(path: string, prefix: string) {
    return path.endsWith(".wasm") ? zxingReaderWasmURL : prefix + path;
  }
};
let zxingPrepared = false;
let zxingReaderPromise: Promise<typeof import("zxing-wasm/reader")> | undefined;

async function wasmDecoder(): Promise<BarcodeDecoder> {
  const zxing = await (zxingReaderPromise ??= import("zxing-wasm/reader"));
  if (!zxingPrepared) {
    zxing.prepareZXingModule({ overrides: zxingOverrides });
    zxingPrepared = true;
  }
  return {
    async detect(video, canvas) {
      const image = canvasFrame(video, canvas);
      if (!image) return null;
      const results = await zxing.readBarcodes(image, {
        formats: ZXING_RETAIL_FORMATS,
        maxNumberOfSymbols: 1,
        tryHarder: true
      });
      const value = results[0]?.text?.trim() ?? "";
      return validRetailBarcode(value) ? value : null;
    }
  };
}

export async function createBarcodeDecoder(): Promise<BarcodeDecoder> {
  const Constructor = nativeBarcodeDetector();
  if (Constructor) {
    try {
      const supported = await Constructor.getSupportedFormats();
      if (RETAIL_BARCODE_FORMATS.every((format) => supported.includes(format))) {
        const detector = new Constructor({ formats: [...RETAIL_BARCODE_FORMATS] });
        return {
          async detect(video) {
            const results = await detector.detect(video);
            const value = results[0]?.rawValue?.trim() ?? "";
            return validRetailBarcode(value) ? value : null;
          }
        };
      }
    } catch {
      // A present but unusable native detector should not prevent the WASM fallback.
    }
  }
  return wasmDecoder();
}

export function freezeCameraFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement): boolean {
  return canvasFrame(video, canvas, CAPTURE_LONG_EDGE) !== null;
}

// Enough for a model to read a nutrition label, small enough to send from a phone on mobile
// data: about 100-250 KB, where an untouched frame would be several megabytes.
const CAPTURE_LONG_EDGE = 1280;

export interface CapturedImage {
  mimeType: string;
  /** Base64 without the data-URL prefix, which is what the estimate route expects. */
  data: string;
}

/**
 * The frame currently on screen, as a still to send for estimation.
 *
 * It draws through the same canvas the preview freezes into, so what is sent is exactly what
 * the person is looking at when they press the button.
 */
export function captureStill(video: HTMLVideoElement, canvas: HTMLCanvasElement): CapturedImage | null {
  if (!canvasFrame(video, canvas, CAPTURE_LONG_EDGE)) return null;
  const url = canvas.toDataURL("image/jpeg", 0.72);
  const comma = url.indexOf(",");
  if (!url.startsWith("data:image/jpeg;base64,") || comma < 0) return null;
  return { mimeType: "image/jpeg", data: url.slice(comma + 1) };
}
