import { useEffect, useRef, useState } from "react";
import type { CapturedImage } from "./barcodeDetection";
import type { ExternalFoodResult, FoodEstimate } from "./types";
import { captureStill, createBarcodeDecoder, freezeCameraFrame, stopCamera } from "./barcodeDetection";

/**
 * What the camera is doing. A detected barcode is deliberately not one of these: it is an offer
 * laid over a camera that keeps running, because pointing at a packet is not the same as asking
 * about the packet, and the photograph is just as likely to be the point.
 */
type CameraPhase = "starting" | "scanning" | "looking-up" | "captured" | "estimating" | "error";

function cameraMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") return "Camera access was not allowed. Enable camera access for this site, then try again.";
    if (error.name === "NotFoundError" || error.name === "OverconstrainedError") return "No suitable camera is available on this device.";
    if (error.name === "NotReadableError") return "The camera is being used by another application.";
  }
  return "The camera could not start. Try again or use Search instead.";
}

export default function FoodCamera({ description, lookup, onProduct, estimate, onEstimate }: {
  /** Whatever is typed in the search field, sent with the photo so it can set the portion. */
  description: string;
  lookup(barcode: string): Promise<ExternalFoodResult | null>;
  onProduct(result: ExternalFoodResult): void;
  estimate(request: { description?: string; image: CapturedImage }): Promise<FoodEstimate>;
  onEstimate(result: FoodEstimate): void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<CameraPhase>("starting");
  const [barcode, setBarcode] = useState("");
  const [message, setMessage] = useState("Starting the rear camera…");
  const [generation, setGeneration] = useState(0);
  // Barcodes the person has already said no to. Without this, the packet still in shot is
  // offered again on the very next pass and the photograph can never be taken.
  const dismissed = useRef(new Set<string>());
  const stopScanning = useRef<() => void>(() => undefined);

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    let timer: number | undefined;
    const stop = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      stopCamera(stream);
      stream = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    };
    stopScanning.current = stop;
    const pauseForVisibility = () => {
      if (document.visibilityState !== "hidden") return;
      cancelled = true;
      stop();
      setPhase("error");
      setMessage("The camera was paused while Calorie Logger was in the background. Tap Try again to resume.");
    };
    const start = async () => {
      setPhase("starting");
      setBarcode("");
      setMessage("Starting the rear camera…");
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" } }
        });
        if (cancelled) { stopCamera(stream); return; }
        const video = videoRef.current;
        const canvas = canvasRef.current;
        if (!video || !canvas) throw new Error("The camera preview is unavailable.");
        video.srcObject = stream;
        await video.play();
        const decoder = await createBarcodeDecoder();
        if (cancelled) return;
        setPhase("scanning");
        setMessage("Point at a barcode, or photograph the food, a label, or a recipe.");
        const scan = async () => {
          if (cancelled) return;
          try {
            const result = await decoder.detect(video, canvas);
            if (cancelled) return;
            if (result && !dismissed.current.has(result)) setBarcode(result);
          } catch {
            if (!cancelled) {
              cancelled = true;
              setPhase("error");
              setMessage("The camera image could not be read. Tap Try again to restart the camera.");
              stop();
            }
            return;
          }
          timer = window.setTimeout(() => void scan(), 250);
        };
        void scan();
      } catch (error) {
        if (!cancelled) {
          setPhase("error");
          setMessage(cameraMessage(error));
          stopCamera(stream);
          stream = null;
        }
      }
    };
    document.addEventListener("visibilitychange", pauseForVisibility);
    void start();
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", pauseForVisibility);
      stop();
    };
  }, [generation]);

  const restart = () => {
    setBarcode("");
    setGeneration((current) => current + 1);
  };

  const dismissBarcode = () => {
    if (barcode) dismissed.current.add(barcode);
    setBarcode("");
  };

  const lookUp = async () => {
    if (!barcode || phase === "looking-up") return;
    const code = barcode;
    setPhase("looking-up");
    setMessage(`Looking up barcode ${code}…`);
    try {
      const result = await lookup(code);
      if (result) {
        stopScanning.current();
        onProduct(result);
        return;
      }
      dismissed.current.add(code);
      setBarcode("");
      setPhase("scanning");
      setMessage(`Open Food Facts has no product for barcode ${code}. Keep scanning, or photograph it instead.`);
    } catch (error) {
      setPhase("error");
      setMessage(error instanceof Error ? error.message : "The barcode lookup failed. Try again.");
    }
  };

  const photograph = async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || phase === "estimating") return;
    const image = captureStill(video, canvas);
    if (!image) {
      setPhase("error");
      setMessage("The camera image could not be captured. Tap Try again to restart the camera.");
      return;
    }
    // The frame is kept on screen while the model reads it, so it is obvious what was sent.
    freezeCameraFrame(video, canvas);
    stopScanning.current();
    setBarcode("");
    setPhase("estimating");
    setMessage(description ? `Estimating this photo with “${description}”…` : "Estimating this photo…");
    try {
      const result = await estimate({ description: description || undefined, image });
      if (!result.recognised) {
        setPhase("captured");
        setMessage(result.note || "No food could be recognised in that photo. Take another, or describe what you ate instead.");
        return;
      }
      onEstimate(result);
    } catch (error) {
      setPhase("captured");
      setMessage(error instanceof Error ? error.message : "The estimate could not be completed.");
    }
  };

  const frozen = phase === "captured" || phase === "estimating";
  const live = phase === "scanning" || phase === "looking-up";
  return <section className="food-camera" aria-label="Camera">
    <div className={`camera-preview ${frozen ? "is-frozen" : ""}`}>
      <video ref={videoRef} autoPlay muted playsInline aria-label="Camera preview" hidden={frozen} />
      <canvas ref={canvasRef} aria-label="Captured photo" hidden={!frozen} />
      {live && !barcode && <span className="camera-guide" aria-hidden="true" />}
      {phase === "starting" && <span className="camera-loading" aria-hidden="true">Opening camera…</span>}
      {barcode && live && <div className="barcode-offer" role="group" aria-label={`Barcode ${barcode} detected`}>
        <strong>Barcode {barcode}</strong>
        <div>
          <button type="button" className="quiet-button" onClick={dismissBarcode} disabled={phase === "looking-up"}>Not this one</button>
          <button type="button" className="primary-button" onClick={() => void lookUp()} disabled={phase === "looking-up"}>
            {phase === "looking-up" ? "Looking up…" : "Look up product"}
          </button>
        </div>
      </div>}
    </div>
    <p className="camera-status" role="status" aria-live="polite">{message}</p>
    {(live || phase === "starting") && <button type="button" className="primary-button full-button" disabled={phase === "starting"} onClick={() => void photograph()}>
      {description ? "Estimate this photo with your description" : "Estimate this photo with AI"}
    </button>}
    {description && (live || phase === "starting") && <p className="camera-description">Sending with the photo: “{description}”</p>}
    {phase === "estimating" && <button type="button" className="primary-button full-button" disabled>Estimating…</button>}
    {phase === "captured" && <button type="button" className="primary-button full-button" onClick={restart}>Take another photo</button>}
    {phase === "error" && <button type="button" className="primary-button full-button" onClick={restart}>Try again</button>}
    <p className="source-attribution">Barcode data: <a href="https://world.openfoodfacts.org" target="_blank" rel="noreferrer">Open Food Facts</a> (ODbL)</p>
  </section>;
}
