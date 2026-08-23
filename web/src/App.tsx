import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import FoodCamera from "./FoodCamera";
import { cameraAvailable } from "./barcodeDetection";
import { currentLogDate, displayDate, moveDate } from "./date";
import pictureCreditsData from "./data/picture-credits.yaml";
import { defaultCatalog } from "./defaultCatalog";
import { localStore } from "./localStore";
import { FoodVisualPicker } from "./FoodVisualPicker";
import { DEFAULT_FOOD_VISUAL, FoodVisual, foodVisualCatalog, isDefaultFoodVisual } from "./foodVisuals";
import { rankFoodVisuals } from "./potion";
import { backendSession, CalorieLoggerApiError, repository } from "./repository";
import type { MacReleaseInfo } from "./repository";
import { saveExportDocument } from "./export";
import { alreadyInstalledOnThisDevice, canPromptInstall, detectedInstallPlatform, installUpdate, isNativeHost, promptInstall, shouldOfferMacApplication, shouldOfferMobileInstall, UPDATE_EVENT, updateStage, type UpdateStage } from "./pwa";
import { appBuild, appVersion } from "./version";
import { SyncChip, SyncPanel } from "./SyncStatus";
import { syncEngine } from "./sync";
import type { StoredSession } from "./session";
import type { EntryPlacement, ExternalFoodResult, ExternalFoodSearchResponse, ExternalFoodSource, Food, FoodEstimate, FoodInput, FoodUnit, LogEntry, Meal, Nutrition, Targets } from "./types";
import { emptyNutrition, scaledNutrition } from "./types";

const pictureCredits = pictureCreditsData as { source: string; url: string; authors: string[] };

const EMPTY_TARGETS: Targets = { calories: null, protein: null, fat: null, carbs: null };
const MEALS: { id: Meal; label: string }[] = [
  { id: "breakfast", label: "Breakfast" },
  { id: "lunch", label: "Lunch" },
  { id: "dinner", label: "Dinner" },
  { id: "snack", label: "Snacks" }
];

// Full words where there is room for them, short ones on a phone, where each column is only as
// wide as the number it has to hold.
const LOG_COLUMNS = [
  { long: "Amount", short: "Amt" },
  { long: "Protein", short: "Prot" },
  { long: "Fat", short: "Fat" },
  { long: "Carbs", short: "Carb" },
  { long: "Energy", short: "Kcal" }
] as const;

function fmt(value: number, calories = false): string {
  return calories ? Math.round(value).toLocaleString("en-GB") : value.toFixed(1);
}

function decimalText(value: string): string | null {
  const normalized = value.replace(",", ".");
  return /^\d*(?:\.\d*)?$/.test(normalized) ? normalized : null;
}

function decimalAriaValue(value: string): number | undefined {
  const number = Number(value);
  return value !== "" && Number.isFinite(number) ? number : undefined;
}

function totalNutrition(entries: LogEntry[]): Nutrition {
  return entries.reduce((total, entry) => ({
    calories: total.calories + entry.calories,
    protein: total.protein + entry.protein,
    fat: total.fat + entry.fat,
    carbs: total.carbs + entry.carbs
  }), emptyNutrition());
}

/**
 * `label` names the dialog for assistive technology and stays put; `title` is what the header
 * shows and follows the step, so a person always reads where they are without the dialog
 * renaming itself underneath a screen reader.
 */
function Modal({ title, label, onClose, onBack, backLabel, children, wide = false, hideHeader = false }: {
  title: string;
  label?: string;
  onClose(): void;
  onBack?(): void;
  backLabel?: string;
  children: ReactNode;
  wide?: boolean;
  hideHeader?: boolean;
}) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [onClose]);
  return (
    <div className={`modal-backdrop ${wide ? "modal-backdrop-wide" : ""}`} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`modal ${wide ? "modal-wide" : ""} ${hideHeader ? "modal-header-hidden" : ""}`} role="dialog" aria-modal="true" aria-label={label ?? title}>
        {!hideHeader && <header className="modal-header">
          {onBack && <button className="icon-button back-button" onClick={onBack} aria-label={backLabel ?? "Back"}><ChevronIcon direction="left" /></button>}
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close">×</button>
        </header>}
        {children}
      </section>
    </div>
  );
}

function ChevronIcon({ direction }: { direction: "left" | "right" }) {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d={direction === "left" ? "m12.5 4.5-5 5.5 5 5.5" : "m7.5 4.5 5 5.5-5 5.5"} /></svg>;
}

function MealChevronIcon({ expanded }: { expanded: boolean }) {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d={expanded ? "m5 7.5 5 5 5-5" : "m7.5 5 5 5-5 5"} /></svg>;
}

function RepeatIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
    <path d="M12 7v5l4 2" />
  </svg>;
}

function PlusIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg>;
}

function PencilIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 20h4l10.5-10.5a2.12 2.12 0 0 0-3-3L5 17v3" />
    <path d="m14.5 6.5 3 3" />
  </svg>;
}

function TrashIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 7h16" />
    <path d="M9 7V5h6v2" />
    <path d="M6 7v13h12V7" />
    <path d="M10 11v5M14 11v5" />
  </svg>;
}

function CameraIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 8h3l1.5-2h9L18 8h3v12H3z" />
    <circle cx="12" cy="13.5" r="3.5" />
  </svg>;
}

function SearchIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </svg>;
}

/* Drawn for the same reason as the others: an emoji sparkle is a different picture on every
   platform, and half of them are a different colour from the rest of the interface. */
function SparkIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10 3.5 11.6 8.4 16.5 10 11.6 11.6 10 16.5 8.4 11.6 3.5 10 8.4 8.4Z" />
    <path d="M17.5 14.5 18.2 16.3 20 17 18.2 17.7 17.5 19.5 16.8 17.7 15 17 16.8 16.3Z" />
  </svg>;
}

/* Drawn rather than typed: the ⚙ character it replaced arrived as a full-colour emoji on iOS,
   a flat glyph on macOS, and something different again on Android. */
function SettingsIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10.03 5.34 10.44 2.68h3.12l.41 2.66a6.95 6.95 0 0 1 1.35.55l2.17-1.58 2.2 2.2-1.58 2.17a6.95 6.95 0 0 1 .55 1.35l2.66.41v3.12l-2.66.41a6.95 6.95 0 0 1-.55 1.35l1.58 2.17-2.2 2.2-2.17-1.58a6.95 6.95 0 0 1-1.35.55l-.41 2.66h-3.12l-.41-2.66a6.95 6.95 0 0 1-1.35-.55l-2.17 1.58-2.2-2.2 1.58-2.17a6.95 6.95 0 0 1-.55-1.35l-2.66-.41v-3.12l2.66-.41a6.95 6.95 0 0 1 .55-1.35L4.31 6.51l2.2-2.2 2.17 1.58a6.95 6.95 0 0 1 1.35-.55Z" />
    <circle cx="12" cy="12" r="3.1" />
  </svg>;
}

function HomeIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 11 9-8 9 8" /><path d="M5 10v10h14V10" /><path d="M9 20v-6h6v6" /></svg>;
}

function InstallGate({ onContinue }: { onContinue(): void }) {
  const platform = detectedInstallPlatform();
  const [promptAvailable, setPromptAvailable] = useState(canPromptInstall());
  const [installedHere, setInstalledHere] = useState(false);
  useEffect(() => {
    let active = true;
    void alreadyInstalledOnThisDevice().then((installed) => { if (active) setInstalledHere(installed); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    const available = () => setPromptAvailable(true);
    const installed = () => onContinue();
    window.addEventListener("calorie-logger-install-available", available);
    window.addEventListener("calorie-logger-installed", installed);
    return () => {
      window.removeEventListener("calorie-logger-install-available", available);
      window.removeEventListener("calorie-logger-installed", installed);
    };
  }, [onContinue]);
  const install = async () => {
    const accepted = await promptInstall();
    setPromptAvailable(false);
    if (accepted) onContinue();
  };
  return <div className="install-page"><section className="install-card" aria-labelledby="install-title">
    <p className="install-kicker">Calorie Logger</p>
    <h1 id="install-title">Install the app</h1>
    {platform === "ios" ? <ol className="install-steps">
      <li>Open this page in <strong>Safari</strong>.</li>
      <li>Tap <strong>Share</strong>.</li>
      <li>Choose <strong>Add to Home Screen</strong>, then tap <strong>Add</strong>.</li>
    </ol> : <>
      <p className="install-copy">{promptAvailable
        ? "Add Calorie Logger to your home screen for a compact, full-screen experience."
        : installedHere
          ? "Calorie Logger is already installed on this device. Open it from your home screen, or carry on here in the browser."
          : "Chrome only offers the install button once. If it does not appear, open the ⋮ menu: it offers Install app when Calorie Logger is not installed yet, and Open app when it already is."}</p>
      {promptAvailable && <button className="primary-button install-button" onClick={() => void install()}>Install Calorie Logger</button>}
    </>}
    <button className="continue-browser" onClick={onContinue}>Continue in browser</button>
  </section></div>;
}

function MetricCard({ label, value, target, kind, onOpenTargets }: { label: string; value: number; target: number | null; kind: keyof Nutrition; onOpenTargets(): void }) {
  const ratio = target && target > 0 ? value / target : 0;
  const exceeded = kind !== "protein" && ratio > 1;
  const reached = kind === "protein" && ratio >= 1;
  return (
    <button className={`metric-card ${exceeded ? "exceeded" : ""} ${reached ? "reached" : ""}`} onClick={onOpenTargets} aria-label={`Edit nutrition targets; ${label} ${fmt(value, kind === "calories")}`}>
      <div className="metric-heading">
        <span>{label}</span>
        <small>{target ? `${Math.round(ratio * 100)}%` : "No target"}</small>
      </div>
      <p><strong>{fmt(value, kind === "calories")}</strong>{target && <span className="metric-target">/ {fmt(target, kind === "calories")}</span>}<span className="metric-unit">{kind === "calories" ? "kcal" : "g"}</span></p>
      <div className="progress-track" aria-label={target ? `${Math.round(ratio * 100)} percent of target` : "Target not set"}>
        <div className="progress-fill" style={{ width: `${Math.min(ratio * 100, 100)}%` }} />
      </div>
    </button>
  );
}

function TargetsForm({ initial, onSave, onClose }: { initial: Targets; onSave(targets: Targets): Promise<void>; onClose(): void }) {
  const [values, setValues] = useState<Record<keyof Targets, string>>({
    calories: initial.calories?.toString() ?? "",
    protein: initial.protein?.toString() ?? "",
    fat: initial.fat?.toString() ?? "",
    carbs: initial.carbs?.toString() ?? ""
  });
  const [saving, setSaving] = useState(false);
  const updateValue = (key: keyof Targets, value: string) => {
    if (key === "calories") {
      setValues((current) => ({ ...current, calories: value }));
      return;
    }
    setValues((current) => {
      const next = { ...current, [key]: value };
      const protein = Number(next.protein);
      const fat = Number(next.fat);
      const carbs = Number(next.carbs);
      next.calories = next.protein !== "" && next.fat !== "" && next.carbs !== ""
        ? String(Math.round(protein * 4 + fat * 9 + carbs * 4))
        : "";
      return next;
    });
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    const parsed = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value === "" ? null : Number(value)])) as unknown as Targets;
    await onSave(parsed).finally(() => setSaving(false));
  };
  return (
    <Modal title="Nutrition targets" onClose={onClose}>
      <form className="stack-form" onSubmit={submit} autoComplete="off">
        <p className="form-note">Enter protein, fat, and carbohydrates to calculate the matching energy target automatically.</p>
        {(["calories", "protein", "fat", "carbs"] as const).map((key) => (
          <label key={key}><span>{key[0].toUpperCase() + key.slice(1)} <small>{key === "calories" ? "kcal" : "g"}</small></span>
            <input aria-describedby={key === "calories" ? "calorie-target-note" : undefined} className="android-input-workaround" type="search" role="spinbutton" inputMode="decimal" autoComplete="off" enterKeyHint={key === "carbs" ? "done" : "next"} aria-valuemin={0} aria-valuenow={decimalAriaValue(values[key])} value={values[key]} onChange={(e) => { const value = decimalText(e.target.value); if (value !== null) updateValue(key, value); }} />
          </label>
        ))}
        <p id="calorie-target-note" className="calculation-note">Energy uses 4 kcal per gram of protein or carbohydrate and 9 kcal per gram of fat. You can still edit it directly.</p>
        <footer className="form-actions"><button type="button" className="quiet-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={saving}>{saving ? "Saving…" : "Save targets"}</button></footer>
      </form>
    </Modal>
  );
}

function minutesToTime(minutes: number): string {
  const hours = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mins = String(minutes % 60).padStart(2, "0");
  return `${hours}:${mins}`;
}

function timeToMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function PreferencesForm({ initial, onSave, onClose }: { initial: number; onSave(minutes: number): Promise<void>; onClose(): void }) {
  const [rolloverTime, setRolloverTime] = useState(minutesToTime(initial));
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    await onSave(timeToMinutes(rolloverTime)).finally(() => setSaving(false));
  };
  return (
    <Modal title="Preferences" onClose={onClose}>
      <form className="stack-form" onSubmit={submit} autoComplete="off">
        <label><span>Day resets at</span>
          <input type="time" value={rolloverTime} onChange={(e) => setRolloverTime(e.target.value)} />
        </label>
        <p className="form-note">Entries logged before this time still count towards the previous day. Set it later than midnight if you log meals overnight.</p>
        <footer className="form-actions"><button type="button" className="quiet-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={saving}>{saving ? "Saving…" : "Save preferences"}</button></footer>
      </form>
    </Modal>
  );
}

type NutritionFieldDraft = { text: string; sourceValue: number | null; edited: boolean };
type UnitDraft = { basisAmount: string; nutrition: Record<keyof Nutrition, NutritionFieldDraft> };

function conciseNumber(value: number): string {
  return String(Number(value.toFixed(4)));
}

function emptyUnitDraft(unit: FoodUnit): UnitDraft {
  return {
    basisAmount: unit === "item" ? "1" : "100",
    nutrition: Object.fromEntries((["calories", "protein", "fat", "carbs"] as const).map((key) => [key, { text: "", sourceValue: null, edited: false }])) as Record<keyof Nutrition, NutritionFieldDraft>
  };
}

// Imported figures arrive at the provider's full precision, and rebasing them onto 100 g adds
// several digits more. No package label carries more than one decimal, so that is what is offered
// for review and saved; a value typed by hand is kept exactly as typed.
function importedNumber(value: number): number {
  return Number(value.toFixed(1));
}

function candidateUnitDraft(candidate: ExternalFoodResult["nutritionCandidates"][number]): UnitDraft {
  return {
    basisAmount: String(importedNumber(candidate.basisAmount)),
    nutrition: Object.fromEntries((["calories", "protein", "fat", "carbs"] as const).map((key) => {
      const value = candidate[key] === null ? null : importedNumber(candidate[key] as number);
      return [key, { text: value === null ? "" : String(value), sourceValue: value, edited: false }];
    })) as Record<keyof Nutrition, NutritionFieldDraft>
  };
}

/**
 * An estimated portion, as the editor's per-item draft.
 *
 * The grams describe the whole portion, so the food is defined for one item and the amount is
 * simply one. Energy is calculated here rather than asked of the model, so it can never disagree
 * with the macros beside it.
 */
function estimateUnitDraft(estimate: FoodEstimate): UnitDraft {
  const field = (value: number): NutritionFieldDraft => ({ text: conciseNumber(Number(value.toFixed(1))), sourceValue: null, edited: true });
  return {
    basisAmount: "1",
    nutrition: {
      calories: field(estimate.protein * 4 + estimate.fat * 9 + estimate.carbs * 4),
      protein: field(estimate.protein),
      fat: field(estimate.fat),
      carbs: field(estimate.carbs)
    }
  };
}

function foodUnitDraft(food: Food): UnitDraft {
  return {
    basisAmount: String(food.basisAmount),
    nutrition: Object.fromEntries((["calories", "protein", "fat", "carbs"] as const).map((key) => [key, { text: conciseNumber(food[key]), sourceValue: food[key], edited: false }])) as Record<keyof Nutrition, NutritionFieldDraft>
  };
}

function FoodForm({ food, external, estimate, oneOffByDefault = false, notice, pictureOpen, onPictureOpen, onPictureClose, onSave }: {
  food?: Food;
  external?: ExternalFoodResult;
  estimate?: FoodEstimate;
  /** Where a new food starts: a described or hand-typed portion is a one-off until told otherwise. */
  oneOffByDefault?: boolean;
  notice?: ReactNode;
  pictureOpen: boolean;
  onPictureOpen(): void;
  onPictureClose(): void;
  onSave(input: FoodInput): Promise<void>;
}) {
  // A described or hand-typed portion is defined per item, because what is typed is what was
  // eaten. A scanned or database food keeps the provider's own basis untouched.
  const initialUnit = food?.unit ?? external?.preferredUnit ?? (estimate || oneOffByDefault ? "item" : "g");
  const [name, setName] = useState(food?.name ?? external?.name ?? estimate?.name ?? "");
  const [icon, setIcon] = useState(food?.icon ?? DEFAULT_FOOD_VISUAL);
  const [unit, setUnit] = useState<FoodUnit>(initialUnit);
  const [oneOff, setOneOff] = useState(food ? food.oneOff : oneOffByDefault);
  const [unitDrafts, setUnitDrafts] = useState<Record<FoodUnit, UnitDraft>>(() => {
    const drafts = { g: emptyUnitDraft("g"), ml: emptyUnitDraft("ml"), item: emptyUnitDraft("item") };
    external?.nutritionCandidates.forEach((candidate) => { drafts[candidate.unit] = candidateUnitDraft(candidate); });
    if (estimate) drafts.item = estimateUnitDraft(estimate);
    if (food) drafts[food.unit] = foodUnitDraft(food);
    return drafts;
  });
  const [saving, setSaving] = useState(false);
  const pictureButtonRef = useRef<HTMLButtonElement>(null);
  const manuallySelectedVisual = useRef(false);
  const automaticallySelectedVisual = useRef<string | undefined>(undefined);
  const draft = unitDrafts[unit];

  useEffect(() => {
    if (manuallySelectedVisual.current || (!isDefaultFoodVisual(icon) && automaticallySelectedVisual.current !== icon) || name.trim().length < 2) return;
    let active = true;
    const timer = window.setTimeout(() => {
      rankFoodVisuals(name, foodVisualCatalog).then(([best]) => {
        if (active && best && !manuallySelectedVisual.current) {
          automaticallySelectedVisual.current = best.item.value;
          setIcon(best.item.value);
        }
      }).catch(() => undefined);
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [icon, name]);

  const updateDraft = (change: Partial<UnitDraft>) => setUnitDrafts((current) => ({ ...current, [unit]: { ...current[unit], ...change } }));
  const updateNutrition = (key: keyof Nutrition, text: string) => setUnitDrafts((current) => {
    const active = current[unit];
    const nutrition = { ...active.nutrition, [key]: { text, sourceValue: null, edited: true } };
    if (key !== "calories") {
      const protein = nutrition.protein.text;
      const fat = nutrition.fat.text;
      const carbs = nutrition.carbs.text;
      if (protein !== "" && fat !== "" && carbs !== "") {
        nutrition.calories = {
          text: conciseNumber(Number(protein) * 4 + Number(fat) * 9 + Number(carbs) * 4),
          sourceValue: null,
          edited: true
        };
      }
    }
    return { ...current, [unit]: { ...active, nutrition } };
  });
  const changeUnit = (nextUnit: FoodUnit) => {
    if (nextUnit === unit) return;
    if (!external) {
      setUnitDrafts((current) => {
        const active = current[unit];
        const target = current[nextUnit];
        return {
          ...current,
          [nextUnit]: {
            basisAmount: nextUnit === "item" ? "1" : unit === "item" ? target.basisAmount : active.basisAmount,
            nutrition: Object.fromEntries((Object.keys(active.nutrition) as (keyof Nutrition)[]).map((key) => [key, { ...active.nutrition[key] }])) as UnitDraft["nutrition"]
          }
        };
      });
    }
    setUnit(nextUnit);
  };
  const closePicture = () => {
    onPictureClose();
    window.setTimeout(() => pictureButtonRef.current?.focus(), 0);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    const nutritionValue = (key: keyof Nutrition) => {
      const field = draft.nutrition[key];
      return !field.edited && field.sourceValue !== null ? field.sourceValue : Number(field.text);
    };
    await onSave({
      name: name.trim(), icon, basisAmount: unit === "item" ? 1 : Number(draft.basisAmount), unit,
      oneOff,
      source: food?.source ?? external?.source ?? null,
      calories: nutritionValue("calories"), protein: nutritionValue("protein"),
      fat: nutritionValue("fat"), carbs: nutritionValue("carbs")
    }).finally(() => setSaving(false));
  };
  return <>
    {/* One scrolling body with a sticky footer. The layer this sits in fills the screen on a
        phone, so anything below the fold is only reachable because this element scrolls. */}
    <form className="food-form" onSubmit={submit} aria-hidden={pictureOpen || undefined} autoComplete="off">
      <div className="form-body">
        {notice}
        <div className="name-and-picture">
          <label className="full-field"><span>Food name{oneOff && <b className="one-off-tag">One-off</b>}</span><input aria-label="Food name" required className="android-input-workaround" type="search" role="textbox" inputMode="text" autoComplete="off" autoCapitalize="words" autoCorrect="on" spellCheck enterKeyHint="next" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="e.g. Greek yoghurt" /></label>
          <div className="picture-field">
            <span>Picture</span>
            <button ref={pictureButtonRef} type="button" onClick={onPictureOpen} aria-label="Change food picture">
              <FoodVisual value={icon} label={name ? `${name} picture` : undefined} />
            </button>
          </div>
        </div>
        {/* One line: the ONE-OFF tag beside the name already says what the unchecked state means,
            and on a phone this row competes with the fields that matter. */}
        <label className="catalogue-field">
          <input type="checkbox" aria-label="Add to my catalogue" checked={!oneOff} onChange={(event) => setOneOff(!event.target.checked)} />
          <strong>Add to my catalogue</strong>
        </label>
        <fieldset className="nutrition-basis">
          <legend>Nutrition values are for</legend>
          <input aria-label="Nutrition basis amount" required className="android-input-workaround" type="search" role="spinbutton" inputMode="decimal" autoComplete="off" enterKeyHint="next" aria-valuemin={0.01} aria-valuenow={unit === "item" ? 1 : decimalAriaValue(draft.basisAmount)} disabled={unit === "item"} value={unit === "item" ? "1" : draft.basisAmount} onChange={(e) => { const value = decimalText(e.target.value); if (value !== null) updateDraft({ basisAmount: value }); }} />
          <select aria-label="Nutrition unit" autoComplete="off" value={unit} onChange={(e) => changeUnit(e.target.value as FoodUnit)}><option value="g">grams</option><option value="ml">millilitres</option><option value="item">item</option></select>
        </fieldset>
        <div className="nutrition-grid">
          {(["calories", "protein", "fat", "carbs"] as const).map((key) => {
            const label = key[0].toUpperCase() + key.slice(1);
            return <label key={key}><span>{label}</span><div className="unit-input"><input aria-label={label} required className="android-input-workaround" type="search" role="spinbutton" inputMode="decimal" autoComplete="off" enterKeyHint={key === "carbs" ? "done" : "next"} aria-valuemin={0} aria-valuenow={decimalAriaValue(draft.nutrition[key].text)} value={draft.nutrition[key].text} onChange={(e) => { const value = decimalText(e.target.value); if (value !== null) updateNutrition(key, value); }} /><small>{key === "calories" ? "kcal" : "g"}</small></div></label>;
          })}
        </div>
        {(food?.source ?? external?.source) && <p className="food-source">Derived from <a href={(food?.source ?? external?.source)?.url} target="_blank" rel="noreferrer">{(food?.source ?? external?.source)?.label}</a></p>}
      </div>
      <footer className="form-actions"><button className="primary-button full-button" disabled={saving}>{saving ? "Saving…" : food ? "Save changes" : "Save"}</button></footer>
    </form>
    {pictureOpen && <section className="dialog-layer picture-layer" role="dialog" aria-modal="true" aria-label="Choose picture">
      <header className="layer-header"><h3>Choose picture</h3><button autoFocus className="icon-button" onClick={closePicture} aria-label="Close picture chooser">×</button></header>
      <FoodVisualPicker value={icon} foodName={name} onChange={(value) => { manuallySelectedVisual.current = true; setIcon(value); closePicture(); }} />
    </section>}
  </>;
}

function FoodChoice({ food, selected = false, onChoose, onEdit, onDelete, checkingDelete = false }: { food: Food; selected?: boolean; onChoose(trigger: HTMLButtonElement): void; onEdit?(trigger: HTMLButtonElement): void; onDelete?(trigger: HTMLButtonElement): void; checkingDelete?: boolean }) {
  return <article className={`food-choice ${selected ? "is-selected" : ""}`}>
    <button className="food-choice-main" aria-current={selected || undefined} onClick={(event) => onChoose(event.currentTarget)}><FoodVisual value={food.icon} className="food-icon" label={food.name} /><span><strong>{food.name}</strong><small>{fmt(food.calories, true)} kcal · {fmt(food.protein)} P · per {food.basisAmount} {food.unit}</small></span></button>
    {(onEdit || onDelete) && <div className="food-choice-actions">
      {onEdit && <button onClick={(event) => onEdit(event.currentTarget)} aria-label={`Edit ${food.name}`} title={`Edit ${food.name}`}><PencilIcon /></button>}
      {onDelete && <button className="danger-text" disabled={checkingDelete} onClick={(event) => onDelete(event.currentTarget)} aria-label={`Delete ${food.name}`} title={`Delete ${food.name}`}><TrashIcon /></button>}
    </div>}
  </article>;
}

function ExternalFoodChoice({ result, onChoose }: { result: ExternalFoodResult; onChoose(trigger: HTMLButtonElement): void }) {
  const candidate = result.nutritionCandidates.find((item) => item.unit === result.preferredUnit) ?? result.nutritionCandidates[0];
  const summary = candidate ? [
    candidate.calories === null ? null : `${fmt(candidate.calories, true)} kcal`,
    candidate.protein === null ? null : `${fmt(candidate.protein)} P`,
    `per ${candidate.basisAmount} ${candidate.unit}`
  ].filter(Boolean).join(" · ") : "Nutrition details need review";
  return <article className="food-choice external-food-choice">
    <button className="food-choice-main" onClick={(event) => onChoose(event.currentTarget)}>
      {result.photoURL ? <span className="food-visual food-photo food-icon"><img src={result.photoURL} alt="" loading="lazy" referrerPolicy="no-referrer" /></span> : <FoodVisual value={DEFAULT_FOOD_VISUAL} className="food-icon" label={result.name} />}
      <span>
        <span className="external-result-title"><strong>{result.name}</strong></span>
        {result.detail && <small>{result.detail}</small>}
        <small>{summary}</small>
      </span>
    </button>
    <a href={result.source.url} target="_blank" rel="noreferrer" aria-label={`View ${result.name} at ${result.source.label}`}>Source</a>
  </article>;
}

function ResetForm({ foodCount, resetting, onCancel, onConfirm }: {
  foodCount: number;
  resetting: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  const { entryCount } = repository.dataSummary();
  return <div className="stack-form">
    <p className="form-note" role="alert">
      This deletes <strong>{entryCount} log {entryCount === 1 ? "entry" : "entries"}</strong> and <strong>{foodCount} saved {foodCount === 1 ? "food" : "foods"}</strong>, and clears your nutrition targets.
      Your other devices are emptied too, the next time they sync.
    </p>
    <p className="form-note">The {defaultCatalog.length} default foods are put back. Your account and sign-in are not affected.</p>
    <footer className="form-actions">
      <button className="quiet-button" onClick={onCancel}>Cancel</button>
      <button className="danger-button" disabled={resetting} onClick={onConfirm}>{resetting ? "Resetting…" : "Delete and restore defaults"}</button>
    </footer>
  </div>;
}

/**
 * What this device is running, and what it can become.
 *
 * The version matters here in a way it does not in most applications: the app and the server move
 * together, and "which build am I on" is the first question when two devices disagree.
 */
function AboutPanel({ update, macApp, onUpdate }: {
  update: UpdateStage | undefined;
  macApp: MacReleaseInfo | null;
  onUpdate(): void;
}) {
  const download = macApp ? repository.downloadURL(macApp.url) : undefined;
  return <div className="stack-form">
    <p className="about-version">Calorie Logger <strong>{appVersion}</strong></p>
    <p className="form-note">Build {appBuild}</p>
    {update === "downloading" && <p className="form-note">Downloading an update in the background. It will be ready in a moment.</p>}
    {update === "ready" && <button className="primary-button" onClick={onUpdate}>Update and reload</button>}
    {!update && <p className="form-note">This is the newest version this server has.</p>}
    {download && !isNativeHost() && <p className="form-note">
      A Mac application is available for this server: <a href={download}>download version {macApp?.version}</a>.
      It keeps today's totals in the menu bar and updates itself from then on.
    </p>}
    <p className="form-note">
      Calorie Logger is self-hosted and stores your log only on your own server and your own devices.
      Nothing about your food is sent anywhere else.
    </p>
  </div>;
}

function PictureCredits() {
  return <div className="stack-form">
    <p className="form-note">
      The {foodVisualCatalog.length} bundled food pictures come from <a href={pictureCredits.url} target="_blank" rel="noreferrer">{pictureCredits.source}</a>, with the rest drawn for Calorie Logger.
      They are stored in the app, so pictures work offline and nothing about your food is sent anywhere to show them.
    </p>
    <p className="picture-credit-authors">Icons created by {pictureCredits.authors.join(" · ")}</p>
  </div>;
}

function nameRank(name: string, query: string): number {
  const normalizedName = name.toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return 0;
  if (normalizedName === normalizedQuery) return 0;
  if (normalizedName.startsWith(normalizedQuery)) return 1;
  if (normalizedName.includes(normalizedQuery)) return 2;
  return 3;
}

/**
 * What the left column shows. One value, not a tab plus six shadow flags: the editor is a step,
 * not a source of foods, and modelling it as a tab is what let a blank form survive on other
 * tabs and left "Back" with nowhere to go.
 */
type Browse =
  | { view: "pick" }
  | { view: "scan" }
  | { view: "edit"; food?: Food; external?: ExternalFoodResult; estimate?: FoodEstimate; oneOff?: boolean; duplicateOf?: Food; from: "pick" | "scan" };

function AddFoodModal({ date, foods, entry, initialMeal, onClose, reportError }: {
  date: string; foods: Food[]; entry?: LogEntry; initialMeal: Meal; onClose(): void; reportError(error: unknown): void;
}) {
  const [browse, setBrowse] = useState<Browse>({ view: "pick" });
  const [query, setQuery] = useState("");
  const [searchResponse, setSearchResponse] = useState<ExternalFoodSearchResponse>();
  // The query the results actually answer. Ranking against the live field instead would silently
  // reshuffle results already on screen as the next query is typed.
  const [searchedQuery, setSearchedQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [estimating, setEstimating] = useState(false);
  const [estimateError, setEstimateError] = useState<string>();
  const [barcodeAvailable, setBarcodeAvailable] = useState(false);
  const [selected, setSelected] = useState<Food | null>(() => {
    if (!entry) return null;
    return foods.find((food) => food.id === entry.foodId) ?? null;
  });
  const [amount, setAmount] = useState(entry?.amount.toString() ?? "");
  const [meal, setMeal] = useState<Meal>(entry?.meal ?? initialMeal);
  const [pictureOpen, setPictureOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState<{ food: Food; entryCount: number }>();
  const [deletingFood, setDeletingFood] = useState(false);
  const searchFieldRef = useRef<HTMLTextAreaElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // A one-off food this modal created and nothing has used yet. It is invisible in the food
  // list, so leaving without logging it would strand a record no screen could ever show again.
  const abandonedOneOff = useRef<string | null>(null);
  // The field takes a description as readily as a name, so its line breaks and runs of spaces
  // are not part of what is being looked for.
  const trimmedQuery = query.replace(/\s+/g, " ").trim();

  const visibleFoods = useMemo(() => foods
    .filter((food) => !food.oneOff && food.name.toLowerCase().includes(trimmedQuery.toLowerCase()))
    .map((food, index) => ({ food, index, rank: nameRank(food.name, trimmedQuery) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ food }) => food), [trimmedQuery, foods]);
  // Products and generic foods are ranked and shown separately. Merged into one list, the ten
  // Open Food Facts products always sat above every CoFID row, so the generic foods the server
  // had already found were pushed off the end of the list and never seen.
  const externalGroups = useMemo(() => {
    const ranked = (source: ExternalFoodSource) => (searchResponse?.results ?? [])
      .map((result, index) => ({ result, index, rank: nameRank(result.name, searchedQuery) }))
      .filter(({ result }) => result.source.provider === source)
      .sort((left, right) => left.rank - right.rank || left.index - right.index)
      .map(({ result }) => result);
    return { products: ranked("openFoodFacts"), generic: ranked("cofid") };
  }, [searchedQuery, searchResponse]);
  const externalResultCount = externalGroups.products.length + externalGroups.generic.length;

  const restoreLayerFocus = () => window.setTimeout(() => returnFocusRef.current?.focus(), 0);
  const choose = (food: Food, trigger?: HTMLButtonElement) => {
    if (trigger) returnFocusRef.current = trigger;
    setSelected(food);
    // Offer the amount last logged for this food. Derived from the entries the replica holds,
    // never stored on the food itself.
    setAmount(String(repository.foodUsage(food.id).lastAmount ?? food.basisAmount));
  };

  useEffect(() => {
    let active = true;
    cameraAvailable().then((available) => { if (active) setBarcodeAvailable(available); });
    return () => { active = false; };
  }, []);

  // The field is as tall as its content. Measured after every change rather than counted in
  // characters, because wrapping depends on the width it actually has.
  useEffect(() => {
    const field = searchFieldRef.current;
    if (!field) return;
    field.style.height = "auto";
    // `scrollHeight` is the content box, and the field is sized border-box, so the borders have
    // to be added back. Two pixels short is enough for the field to scroll its own last line.
    const borders = field.offsetHeight - field.clientHeight;
    if (field.scrollHeight) field.style.height = `${field.scrollHeight + borders}px`;
  }, [query, browse.view]);

  // Keep the chosen food visible in the list beside the amount panel, so it reads as "this
  // entry's food, with alternatives around it" rather than an unrelated catalogue.
  useEffect(() => {
    if (browse.view !== "pick" || !selected) return;
    const row = listRef.current?.querySelector("[aria-current]");
    row?.scrollIntoView?.({ block: "nearest" });
  }, [browse.view, selected]);

  const openExternal = (result: ExternalFoodResult, from: "pick" | "scan") => {
    const existing = foods.find((food) => food.source?.provider === result.source.provider && food.source.id === result.source.id);
    setBrowse(existing
      ? { view: "edit", food: existing, external: result, duplicateOf: existing, from }
      : { view: "edit", external: result, from });
  };

  const saveFood = async (input: FoodInput) => {
    const editing = browse.view === "edit" ? browse.food : undefined;
    try {
      const saved = await repository.saveFood(input, editing?.id);
      // Saving a food never logs anything. It selects the food and offers the amount step; the
      // entry is written only by "Add to day".
      //
      // The search is finished, so it is cleared: leaving the query in place filtered the food
      // that was just saved straight back out of the list beside the amount panel, under a query
      // typed to find something it is no longer named after.
      setBrowse({ view: "pick" });
      setQuery("");
      setSearchResponse(undefined);
      setSearchedQuery("");
      setSelected(saved);
      if (!editing && saved.oneOff) abandonedOneOff.current = saved.id;
      if (!entry) setAmount(String(repository.foodUsage(saved.id).lastAmount ?? saved.basisAmount));
    } catch (error) { reportError(error); }
  };

  /**
   * Discards a one-off this modal created and nothing ended up using.
   *
   * It is invisible in the food list by design, so a one-off left behind by closing the modal,
   * or by logging a different food in the end, could never be reached again.
   */
  const discardUnusedOneOff = (loggedFoodId?: string) => {
    const stranded = abandonedOneOff.current;
    abandonedOneOff.current = null;
    if (stranded && stranded !== loggedFoodId) void repository.deleteFood(stranded).catch(() => undefined);
  };
  const close = () => { discardUnusedOneOff(); onClose(); };

  const prepareFoodDeletion = (food: Food, trigger: HTMLButtonElement) => {
    returnFocusRef.current = trigger;
    setDeleteCandidate({ food, entryCount: repository.foodUsage(food.id).entryCount });
  };
  const cancelFoodDeletion = () => {
    setDeleteCandidate(undefined);
    restoreLayerFocus();
  };
  const removeFood = async () => {
    if (!deleteCandidate || deletingFood) return;
    const { food } = deleteCandidate;
    setDeletingFood(true);
    try {
      await repository.deleteFood(food.id);
      if (abandonedOneOff.current === food.id) abandonedOneOff.current = null;
      setDeleteCandidate(undefined);
      if (selected?.id === food.id) setSelected(null);
      if (browse.view === "edit" && browse.food?.id === food.id) setBrowse({ view: "pick" });
      if (entry?.foodId === food.id) onClose();
      else restoreLayerFocus();
    } catch (error) { reportError(error); }
    finally { setDeletingFood(false); }
  };

  const searchExternal = async () => {
    if (trimmedQuery.length < 2 || trimmedQuery.length > 120 || searching) return;
    setSearching(true);
    try {
      setSearchResponse(await repository.searchExternalFoods(trimmedQuery));
      setSearchedQuery(trimmedQuery);
    } catch (error) {
      reportError(error);
    } finally {
      setSearching(false);
    }
  };

  const estimateDescription = async () => {
    if (trimmedQuery.length < 2 || trimmedQuery.length > 400 || estimating) return;
    setEstimating(true);
    setEstimateError(undefined);
    try {
      const estimate = await repository.estimateFood({ description: trimmedQuery });
      if (!estimate.recognised) {
        setEstimateError(estimate.note || `That could not be estimated as food. Try describing what you ate and roughly how much.`);
        return;
      }
      setBrowse({ view: "edit", estimate, oneOff: true, from: "pick" });
    } catch (error) {
      // Reported here rather than as an app-level failure: nothing else in the picker is
      // affected, and the catalogue below is still perfectly usable.
      setEstimateError(error instanceof CalorieLoggerApiError ? error.message : "The estimate could not be completed.");
    } finally {
      setEstimating(false);
    }
  };

  // Enter searches the databases only when nothing of yours matches. With matches on screen it
  // just puts the keyboard away so they can be read, and never spends a rate-limited request
  // the person did not ask for.
  const submitQuery = () => {
    if (visibleFoods.length) searchFieldRef.current?.blur();
    else void searchExternal();
  };

  const submit = async () => {
    if (!selected || !amount || Number(amount) <= 0) return;
    setSaving(true);
    try {
      if (entry) await repository.updateEntry(entry.id, date, Number(amount), meal, selected.id);
      else await repository.addEntry(date, selected.id, Number(amount), meal);
      discardUnusedOneOff(selected.id);
      onClose();
    } catch (error) { reportError(error); } finally { setSaving(false); }
  };

  const stepTitle = browse.view === "scan" ? "Camera"
    : browse.view === "edit" ? (browse.food ? "Edit food" : "New food")
    : entry ? "Edit entry" : "Add food";
  // The amount panel belongs to the picker, so it shows only there. Leaving it up during an edit
  // or a scan put one food in the editor and a different one beside it, offering to log a food
  // the person had stopped looking at. The selection itself is kept, so backing out of the editor
  // returns to it; the phone additionally needs this because the sheet covers the picker and must
  // never cover the editor.
  const showAmount = Boolean(selected) && browse.view === "pick";
  const back = browse.view === "edit" ? () => { setBrowse({ view: browse.from }); restoreLayerFocus(); }
    : browse.view === "scan" ? () => setBrowse({ view: "pick" })
    : showAmount && !entry ? () => { setSelected(null); restoreLayerFocus(); }
    : undefined;

  return <Modal
    title={stepTitle}
    label={entry ? "Edit entry" : "Add food"}
    onClose={pictureOpen ? () => setPictureOpen(false) : deleteCandidate ? cancelFoodDeletion : close}
    onBack={back}
    backLabel={browse.view === "edit" ? "Back" : "Choose a different food"}
    wide
    hideHeader={pictureOpen}
  >
    <div className="add-layout">
      <div className="food-browser">
        {browse.view === "edit" ? <section className="food-editor-view" aria-label={browse.external ? "Review food" : browse.food ? "Edit food" : "Create a food"}>
          <FoodForm
            food={browse.food}
            external={browse.external}
            estimate={browse.estimate}
            oneOffByDefault={browse.oneOff ?? false}
            pictureOpen={pictureOpen}
            onPictureOpen={() => setPictureOpen(true)}
            onPictureClose={() => setPictureOpen(false)}
            notice={browse.duplicateOf
              ? <aside className="import-notice duplicate-notice"><strong>Already in your catalogue</strong><span>This result comes from the same source as {browse.duplicateOf.name}. Saving will update the existing food instead of creating a duplicate.</span></aside>
              : browse.estimate
                ? <aside className={`import-notice estimate-notice ${browse.estimate.confidence === "low" ? "low-confidence" : ""}`}>
                  <strong>Estimated from your description — check the numbers</strong>
                  {browse.estimate.portion && <span>For {browse.estimate.portion}.</span>}
                  {browse.estimate.note && <span>{browse.estimate.note}</span>}
                  {browse.estimate.confidence === "low" && <span>This one is a rough guess. Adjust anything that looks wrong before saving.</span>}
                </aside>
              : browse.external?.warnings?.length
                ? <aside className="import-notice source-warning"><strong>Check the package label</strong>{browse.external.warnings.map((warning) => <span key={warning}>{warning}</span>)}</aside>
                : undefined}
            onSave={saveFood}
          />
        </section>
        : browse.view === "scan" ? <FoodCamera
          description={trimmedQuery}
          lookup={(barcode) => repository.lookupExternalFood(barcode)}
          onProduct={(result) => openExternal(result, "scan")}
          estimate={(request) => repository.estimateFood(request)}
          onEstimate={(estimate) => setBrowse({ view: "edit", estimate, oneOff: true, from: "scan" })}
        />
        : <>
          <form className="food-search-field" role="search" autoComplete="off" onSubmit={(event) => { event.preventDefault(); submitQuery(); }}>
            <label className="visually-hidden" htmlFor="food-query">Search foods</label>
            <SearchIcon />
            {/* A description is not a keyword, so the field grows with what is typed instead of
                scrolling it past a slot one line high. It never scrolls itself: the column
                around it is the only scroller here. */}
            <textarea id="food-query" ref={searchFieldRef} rows={1} className="search-input android-input-workaround" role="searchbox" aria-multiline="false" inputMode="search" autoComplete="off" autoCapitalize="sentences" autoCorrect="on" spellCheck enterKeyHint="search" maxLength={400} value={query}
              onChange={(event) => { setQuery(event.target.value); setEstimateError(undefined); }}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submitQuery(); } }}
              placeholder="Search foods, or describe what you ate" />
            {barcodeAvailable && <button type="button" className="scan-button" onClick={() => setBrowse({ view: "scan" })} aria-label="Scan a barcode or photograph food" title="Scan a barcode or photograph food"><CameraIcon /></button>}
          </form>

          <div className="food-list" ref={listRef}>
            {/* At the top, because these are what the typed text is for when the catalogue does
                not already hold it. Below the foods they were a scroll away on a phone. */}
            {trimmedQuery.length >= 2 && <section className="food-group action-group">
              <h4>Add “{trimmedQuery}”</h4>
              <button type="button" className="food-action" disabled={estimating} onClick={() => void estimateDescription()}>
                <SparkIcon />
                <span><strong>{estimating ? "Estimating…" : "Estimate it with AI"}</strong><small>Nutrition guessed from your description</small></span>
              </button>
              <button type="button" className="food-action" onClick={() => setBrowse({ view: "edit", oneOff: true, from: "pick" })}>
                <PlusIcon />
                <span><strong>Enter the numbers myself</strong><small>Type the protein, fat and carbs for this portion</small></span>
              </button>
              {trimmedQuery.length <= 120 && <button type="button" className="food-action" disabled={searching} onClick={() => void searchExternal()}>
                <SearchIcon />
                <span><strong>{searching ? "Searching…" : "Search food databases"}</strong><small>Open Food Facts and CoFID</small></span>
              </button>}
              {estimateError && <p className="provider-error">{estimateError}</p>}
            </section>}

            {visibleFoods.length > 0 && <section className="food-group">
              <h4>Your foods</h4>
              {visibleFoods.map((food) => <FoodChoice
                key={food.id}
                food={food}
                selected={selected?.id === food.id}
                onChoose={(trigger) => choose(food, trigger)}
                onEdit={(trigger) => { returnFocusRef.current = trigger; setBrowse({ view: "edit", food, from: "pick" }); }}
                onDelete={(trigger) => prepareFoodDeletion(food, trigger)}
              />)}
            </section>}

            {!searching && searchResponse?.errors.map((error) => <p className="provider-error" key={error.source}>{error.message}</p>)}

            {!searching && searchedQuery && ([
              { key: "products", title: "Products", results: externalGroups.products },
              { key: "generic", title: "Generic foods", results: externalGroups.generic }
            ] as const).filter((group) => group.results.length).map((group) => <section className="food-group external-group" key={group.key}>
              <h4>{group.title}</h4>
              {group.results.map((result) => <ExternalFoodChoice key={result.id} result={result} onChoose={(trigger) => { returnFocusRef.current = trigger; openExternal(result, "pick"); }} />)}
            </section>)}

            {!searching && searchedQuery === trimmedQuery && searchedQuery && !externalResultCount && <p className="provider-empty">No database matches for “{searchedQuery}”. Estimate it or enter the numbers yourself above.</p>}

            {!visibleFoods.length && !trimmedQuery && <div className="empty-mini"><span>No saved foods yet.</span></div>}

            {!trimmedQuery && <button type="button" className="food-action" onClick={() => setBrowse({ view: "edit", from: "pick" })}>
              <PlusIcon />
              <span><strong>Create a food by hand</strong><small>Add it to your catalogue from a label</small></span>
            </button>}
          </div>

          <p className="source-attribution">Data: <a href="https://world.openfoodfacts.org" target="_blank" rel="noreferrer">Open Food Facts</a> (ODbL) · <a href="https://www.gov.uk/government/publications/composition-of-foods-integrated-dataset-cofid" target="_blank" rel="noreferrer">CoFID 2021</a> (OGL)</p>
        </>}
      </div>

      <aside className={`quantity-panel ${showAmount ? "active-sheet" : ""}`}>
        {showAmount && selected ? <>
          <div className="selected-food">
            <FoodVisual value={selected.icon} className="large-icon" label={selected.name} />
            <div><small>Selected food</small><h3>{selected.name}</h3></div>
            <button type="button" className="edit-selected" onClick={() => setBrowse({ view: "edit", food: selected, from: "pick" })} aria-label="Edit selected food" title={`Edit ${selected.name}`}><PencilIcon /></button>
          </div>
          <label className="amount-field"><span>Amount consumed</span><div><input aria-label="Amount consumed" autoFocus className="android-input-workaround" type="search" role="spinbutton" inputMode="decimal" autoComplete="off" enterKeyHint="done" aria-valuemin={0.01} aria-valuenow={decimalAriaValue(amount)} value={amount} onChange={(e) => { const value = decimalText(e.target.value); if (value !== null) setAmount(value); }} /><b>{selected.unit === "item" ? Number(amount) === 1 ? "item" : "items" : selected.unit}</b></div></label>
          <label className="meal-field"><span>Meal</span><select value={meal} onChange={(event) => setMeal(event.target.value as Meal)}>{MEALS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
          <div className="preview-grid">{Object.entries(scaledNutrition(selected, Number(amount) || 0)).map(([key, value]) => <div key={key}><span>{key}</span><strong>{fmt(value, key === "calories")}</strong><small>{key === "calories" ? "kcal" : "g"}</small></div>)}</div>
          <button className="primary-button full-button" onClick={submit} disabled={saving || Number(amount) <= 0}>{saving ? "Saving…" : entry ? "Update entry" : "Add to day"}</button>
        </> : <div className="quantity-placeholder"><span>↖</span><p>Choose a food to set the amount and preview its nutrition.</p></div>}
      </aside>
    </div>
    {deleteCandidate && <section className="dialog-layer food-delete-layer" role="alertdialog" aria-modal="true" aria-labelledby="food-delete-title" aria-describedby="food-delete-description">
      <div className="food-delete-card">
        <FoodVisual value={deleteCandidate.food.icon} className="large-icon" label={deleteCandidate.food.name} />
        <div className="food-delete-copy">
          <small>Delete from catalogue</small>
          <h3 id="food-delete-title">Delete {deleteCandidate.food.name}?</h3>
          <p id="food-delete-description">{deleteCandidate.entryCount > 0
            ? `This food is used in ${deleteCandidate.entryCount} log ${deleteCandidate.entryCount === 1 ? "entry" : "entries"}. Deleting it will also permanently delete ${deleteCandidate.entryCount === 1 ? "that entry" : `all ${deleteCandidate.entryCount} entries`}.`
            : "This food is not used in any log entries."}</p>
        </div>
        <footer className="form-actions">
          <button autoFocus type="button" className="quiet-button" disabled={deletingFood} onClick={cancelFoodDeletion}>Cancel</button>
          <button type="button" className="danger-button" disabled={deletingFood} onClick={() => void removeFood()}>{deletingFood ? "Deleting…" : deleteCandidate.entryCount > 0 ? `Delete food and ${deleteCandidate.entryCount === 1 ? "entry" : `${deleteCandidate.entryCount} entries`}` : "Delete food"}</button>
        </footer>
      </div>
    </section>}
  </Modal>;
}

function ExportModal({ date, onClose, reportError }: { date: string; onClose(): void; reportError(error: unknown): void }) {
  const [scope, setScope] = useState<"all" | "range">("all");
  const [startDate, setStartDate] = useState(date);
  const [endDate, setEndDate] = useState(date);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const request = scope === "all" ? { scope } as const : { scope, startDate, endDate } as const;
      await saveExportDocument(repository.exportData(request), request);
      onClose();
    } catch (error) { reportError(error); }
  };
  return <Modal title="Export data" onClose={onClose}><form className="stack-form" onSubmit={submit}>
    <label className="radio-row"><input type="radio" checked={scope === "all"} onChange={() => setScope("all")} /><span><strong>All data</strong><small>Foods, targets, and every logged day</small></span></label>
    <label className="radio-row"><input type="radio" checked={scope === "range"} onChange={() => setScope("range")} /><span><strong>Date range</strong><small>Entries and the saved foods they reference</small></span></label>
    {scope === "range" && <div className="date-range"><label><span>From</span><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label><label><span>To</span><input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} /></label></div>}
    <footer className="form-actions"><button type="button" className="quiet-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={scope === "range" && startDate > endDate}>Choose location…</button></footer>
  </form></Modal>;
}

function ConnectionForm({ initial, onConnected, onCancel }: { initial?: Partial<StoredSession>; onConnected(session: StoredSession): void; onCancel?: () => void }) {
  const nativeConnection = Boolean(window.webkit?.messageHandlers?.calorieLogger);
  const [baseUrl, setBaseUrl] = useState(nativeConnection ? initial?.baseUrl || "" : window.location.origin);
  const [email, setEmail] = useState(initial?.email || "");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();
  const [connectionSucceeded, setConnectionSucceeded] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setMessage(undefined); setConnectionSucceeded(false);
    try { onConnected(await backendSession.login(baseUrl, email, password)); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  };
  return <form className="connection-form stack-form" onSubmit={submit}>
    <div className="connection-intro"><h1>Sign in</h1></div>
    <p className="form-note">Use the account created by your administrator. Your password is used only to sign in and is never saved.</p>
    {nativeConnection && <label><span>Server URL</span><input className="android-input-workaround" type="search" role="textbox" inputMode="url" autoComplete="off" enterKeyHint="next" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://logger.example.com:8091" required autoCapitalize="none" autoCorrect="off" aria-describedby="server-url-help" /><small id="server-url-help" className="field-help">Enter the server origin, including its port when needed.</small></label>}
    <label><span>Email</span><input type="email" inputMode="email" enterKeyHint="next" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="username" autoCapitalize="none" /></label>
    <label><span>Password</span><input type="password" enterKeyHint="done" value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete="current-password" /></label>
    {message && <p className={connectionSucceeded ? "connection-success" : "connection-error"} role={connectionSucceeded ? "status" : "alert"}>{message}</p>}
    <footer className="form-actions">{onCancel && <button type="button" className="quiet-button" onClick={onCancel}>Cancel</button>}{nativeConnection && <button type="button" className="quiet-button" disabled={saving || !baseUrl} onClick={async () => { setSaving(true); setMessage(undefined); setConnectionSucceeded(false); try { await backendSession.health(baseUrl); setConnectionSucceeded(true); setMessage("Connection succeeded."); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setSaving(false); } }}>Test connection</button>}<button className="primary-button" disabled={saving}>{saving ? "Signing in…" : "Sign in"}</button></footer>
  </form>;
}

function MealTotals({ totals }: { totals: Nutrition }) {
  return <>
    <span className="meal-total" aria-label={`Protein ${fmt(totals.protein)} grams`}>{fmt(totals.protein)}</span>
    <span className="meal-total" aria-label={`Fat ${fmt(totals.fat)} grams`}>{fmt(totals.fat)}</span>
    <span className="meal-total" aria-label={`Carbohydrates ${fmt(totals.carbs)} grams`}>{fmt(totals.carbs)}</span>
    <span className="meal-total energy-cell" aria-label={`Energy ${fmt(totals.calories, true)} kilocalories`}>{fmt(totals.calories, true)}</span>
  </>;
}

type DropTarget = { meal: Meal; entryId?: string; position: "before" | "after" | "end" };

export default function App() {
  const [showInstall, setShowInstall] = useState(() => shouldOfferMobileInstall() && sessionStorage.getItem("calorie-logger-install-dismissed") !== "true");
  const [session, setSession] = useState<StoredSession | null | undefined>(undefined);
  const [connectionDefaults, setConnectionDefaults] = useState<Partial<StoredSession>>({});
  const [date, setDate] = useState(currentLogDate(0));
  // The interface renders the local replica directly. Reads never wait on a server, and a sync
  // that brings in another device's entries repaints the day exactly like a local edit does.
  const snapshot = useSyncExternalStore(localStore.subscribe, localStore.getSnapshot);
  const syncStatus = useSyncExternalStore(syncEngine.subscribe, syncEngine.getStatus);
  const { foods, targets, dayRolloverMinutes } = snapshot;
  const day = useMemo(() => repository.day(date), [snapshot, date]);
  // Independent of whatever date the log is navigated to, for the native menu-bar summary.
  const menuDate = currentLogDate(dayRolloverMinutes);
  const menuDay = useMemo(() => repository.day(menuDate), [snapshot, menuDate]);
  const loading = !snapshot.ready;
  const [modal, setModal] = useState<"add" | "targets" | "preferences" | "copy" | "export" | "connection" | "settings" | "sync" | "reset" | "credits" | "about" | null>(null);
  const [update, setUpdate] = useState<UpdateStage | undefined>(() => updateStage());
  const [macApp, setMacApp] = useState<MacReleaseInfo | null>(null);
  const [macBannerDismissed, setMacBannerDismissed] = useState(() => localStorage.getItem("calorie-logger-mac-offer-dismissed") === "true");
  const [resetting, setResetting] = useState(false);
  const [editingEntry, setEditingEntry] = useState<LogEntry>();
  const [addMeal, setAddMeal] = useState<Meal>("breakfast");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [collapsedMeals, setCollapsedMeals] = useState<Set<Meal>>(new Set());
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [copyDate, setCopyDate] = useState(moveDate(date, 1));
  const [dragging, setDragging] = useState<string>();
  const [dropTarget, setDropTarget] = useState<DropTarget>();
  const dropTargetRef = useRef<DropTarget | undefined>(undefined);
  const [error, setError] = useState<string>();
  useEffect(() => {
    const changed = (event: Event) => setUpdate((event as CustomEvent<UpdateStage | undefined>).detail);
    window.addEventListener(UPDATE_EVENT, changed);
    return () => window.removeEventListener(UPDATE_EVENT, changed);
  }, []);

  // Asked for once a session is live, and never awaited by anything on screen: a server with no
  // desktop application, or no connection at all, simply means the offer is not made.
  useEffect(() => {
    if (!session?.token) return;
    let active = true;
    void repository.macRelease()
      .then((release) => { if (active) setMacApp(release); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [session?.token]);

  const dismissMacBanner = () => {
    localStorage.setItem("calorie-logger-mac-offer-dismissed", "true");
    setMacBannerDismissed(true);
  };

  const dismissInstall = useCallback(() => {
    sessionStorage.setItem("calorie-logger-install-dismissed", "true");
    setShowInstall(false);
  }, []);
  // Connection health is reported by the sync engine, not inferred from whichever error happened
  // to arrive last, so a validation failure can no longer masquerade as being offline.
  const reportError = (value: unknown) => setError(value instanceof Error ? value.message : String(value));

  const requireLogin = useCallback(() => {
    const current = backendSession.current();
    if (current) setConnectionDefaults({ baseUrl: current.baseUrl, email: current.email });
    // The replica is deliberately kept: the data is still the owner's, and signing back in
    // restores the day immediately, unsent changes included.
    syncEngine.stop();
    void backendSession.reject(); setSession(null); setModal(null);
  }, []);

  const beginSession = useCallback(async (connected: StoredSession) => {
    backendSession.configure(connected, requireLogin);
    await localStore.load(connected.userId ?? connected.email);
    setSession(connected);
    syncEngine.start();
  }, [requireLogin]);

  // Opening the app is entirely local work. Every step is guarded so that a failure leaves the
  // owner at the sign-in screen rather than on the loading screen for ever.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let stored: StoredSession | null = null;
      try { stored = await backendSession.restore(); } catch (error) { reportError(error); }
      if (cancelled) return;
      if (!stored?.token) {
        setConnectionDefaults(stored ?? {});
        setSession(null);
        return;
      }
      try { await beginSession(stored); } catch (error) { reportError(error); setSession(null); }
      if (cancelled) return;
      // Extending the token happens once the day is already on screen, and signs the owner out
      // only if the server answers and rejects it.
      if (!(await backendSession.refresh())) requireLogin();
    })();
    return () => { cancelled = true; };
  }, [beginSession, requireLogin]);

  useEffect(() => { setSelected(new Set()); setConfirmingDelete(false); }, [date]);

  const publishNativeSummary = useCallback(async () => {
    const native = window.webkit?.messageHandlers?.calorieLogger;
    if (!native || !session?.token) return;
    await native.postMessage({ method: "updateMenuSummary", payload: { day: menuDay, targets } });
  }, [menuDay, targets, session]);
  useEffect(() => { void publishNativeSummary(); }, [publishNativeSummary]);
  useEffect(() => {
    const native = window.webkit?.messageHandlers?.calorieLogger;
    const state = !session?.token ? "signedOut" : syncStatus.state === "offline" ? "offline" : syncStatus.state === "blocked" ? "error" : "connected";
    if (native) void native.postMessage({ method: "updateMenuState", payload: { state } });
  }, [session, syncStatus.state]);

  useEffect(() => {
    window.calorieLogger = {
      openAddFood: () => { setEditingEntry(undefined); setAddMeal("breakfast"); setModal("add"); },
      openTargets: () => setModal("targets"),
      openExport: () => setModal("export"),
      openConnection: () => setModal("connection"),
      jumpToToday: () => setDate(menuDate),
      refreshNativeSummary: async () => { await syncEngine.syncNow(); await publishNativeSummary(); }
    };
    return () => { delete window.calorieLogger; };
  }, [publishNativeSummary, menuDate]);

  const dateDisplay = displayDate(date);
  const toggleSelected = (id: string) => {
    setConfirmingDelete(false);
    setSelected((current) => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });
  };
  const reorder = async (placements: EntryPlacement[]) => {
    try { await repository.reorderEntries(placements); } catch (e) { reportError(e); }
  };
  const placementsForDrop = useCallback((draggedId: string, target: DropTarget): EntryPlacement[] => {
    const grouped = Object.fromEntries(MEALS.map(({ id }) => [id, day.entries.filter((entry) => entry.meal === id && entry.id !== draggedId)])) as Record<Meal, LogEntry[]>;
    const destination = grouped[target.meal];
    let index = destination.length;
    if (target.entryId) {
      const hoveredIndex = destination.findIndex((entry) => entry.id === target.entryId);
      if (hoveredIndex >= 0) index = hoveredIndex + (target.position === "after" ? 1 : 0);
    }
    const dragged = day.entries.find((entry) => entry.id === draggedId);
    if (dragged) destination.splice(index, 0, { ...dragged, meal: target.meal });
    return MEALS.flatMap(({ id }) => grouped[id].map((entry) => ({ id: entry.id, meal: id })));
  }, [day.entries]);
  const finishDrag = useCallback((draggedId: string, target?: DropTarget) => {
    if (target) void reorder(placementsForDrop(draggedId, target));
    setDragging(undefined); setDropTarget(undefined); dropTargetRef.current = undefined;
  }, [placementsForDrop, date]);
  const updatePointerTarget = useCallback((x: number, y: number) => {
    const element = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-entry], [data-meal-drop]");
    if (!element) return;
    const meal = element.dataset.meal as Meal;
    const entryId = element.dataset.dropEntry;
    const rect = element.getBoundingClientRect();
    const next: DropTarget = entryId
      ? { meal, entryId, position: y < rect.top + rect.height / 2 ? "before" : "after" }
      : { meal, position: "end" };
    dropTargetRef.current = next; setDropTarget(next);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => { if (event.pointerType !== "mouse") event.preventDefault(); updatePointerTarget(event.clientX, event.clientY); };
    const up = () => finishDrag(dragging, dropTargetRef.current);
    document.addEventListener("pointermove", move, { passive: false });
    document.addEventListener("pointerup", up, { once: true });
    document.addEventListener("pointercancel", up, { once: true });
    return () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
    };
  }, [dragging, finishDrag, updatePointerTarget]);

  const deleteSelected = async () => {
    try {
      await repository.deleteEntries([...selected]);
      setSelected(new Set()); setConfirmingDelete(false);
    } catch (e) { reportError(e); }
  };
  const copySelected = async () => {
    try { await repository.copyEntries([...selected], copyDate); setSelected(new Set()); setModal(null); } catch (e) { reportError(e); }
  };
  const repeatMeal = async (meal: Meal) => {
    try { await repository.repeatPreviousMeal(date, meal); } catch (e) { reportError(e); }
  };
  const saveTargets = async (next: Targets) => {
    try { await repository.saveTargets(next); setModal(null); } catch (e) { reportError(e); }
  };
  const saveDayRollover = async (minutes: number) => {
    try { await repository.saveDayRollover(minutes); setModal(null); } catch (e) { reportError(e); }
  };
  const signOut = async () => {
    setConnectionDefaults({ baseUrl: session?.baseUrl, email: session?.email });
    syncEngine.stop();
    await backendSession.logout();
    await localStore.clear();
    setSession(null);
  };
  const edit = (entry: LogEntry) => { setEditingEntry(entry); setAddMeal(entry.meal); setModal("add"); };
  const openAdd = (meal: Meal = "breakfast") => { setEditingEntry(undefined); setAddMeal(meal); setModal("add"); };
  const toggleMeal = (meal: Meal) => setCollapsedMeals((current) => {
    const next = new Set(current);
    next.has(meal) ? next.delete(meal) : next.add(meal);
    return next;
  });

  if (showInstall) return <InstallGate onContinue={dismissInstall} />;
  if (session === undefined) return <div className="connection-page"><p>Opening Calorie Logger…</p></div>;
  if (!session?.token) return <div className="connection-page"><ConnectionForm initial={connectionDefaults} onConnected={(connected) => void beginSession(connected)} /></div>;

  const offerMacApp = macApp && shouldOfferMacApplication() && !macBannerDismissed;

  return <div className="app-shell">
    <main>
      {offerMacApp && <section className="app-banner">
        <span>Calorie Logger has a Mac app: today's totals in the menu bar, and it updates itself.</span>
        <a className="banner-action" href={repository.downloadURL(macApp.url)}>Download</a>
        <button className="banner-dismiss" onClick={dismissMacBanner} aria-label="Do not offer the Mac app again">×</button>
      </section>}
      <section className="date-header">
        {date !== menuDate && <button className="today-button" onClick={() => setDate(menuDate)} aria-label="Go to today" title="Go to today"><HomeIcon /></button>}
        <div className="date-navigation">
          <button className="date-arrow" onClick={() => setDate(moveDate(date, -1))} aria-label="Previous day"><ChevronIcon direction="left" /></button>
          <div className="date-title"><h1>{dateDisplay.title}</h1><span className="date-weekday">{dateDisplay.eyebrow}</span></div>
          <button className="date-arrow" onClick={() => setDate(moveDate(date, 1))} aria-label="Next day"><ChevronIcon direction="right" /></button>
        </div>
        <div className="header-actions">
          <SyncChip status={syncStatus} onOpen={() => setModal("sync")} />
          <button
            className={`settings-button ${update === "ready" ? "has-update" : ""}`}
            onClick={() => setModal("settings")}
            aria-label={update === "ready" ? "Open settings; an update is ready" : "Open settings"}
          ><SettingsIcon /></button>
        </div>
      </section>

      <section className="metrics-grid" aria-label="Nutrition totals">
        <MetricCard label="Energy" value={day.totals.calories} target={targets.calories} kind="calories" onOpenTargets={() => setModal("targets")} />
        <MetricCard label="Protein" value={day.totals.protein} target={targets.protein} kind="protein" onOpenTargets={() => setModal("targets")} />
        <MetricCard label="Fat" value={day.totals.fat} target={targets.fat} kind="fat" onOpenTargets={() => setModal("targets")} />
        <MetricCard label="Carbs" value={day.totals.carbs} target={targets.carbs} kind="carbs" onOpenTargets={() => setModal("targets")} />
      </section>

      <section className="log-section">
        {reordering && <div className="mode-bar"><strong>Drag entries into place</strong><button onClick={() => { setReordering(false); setDragging(undefined); }}>Done</button></div>}
        {selecting && <div className={`selection-bar ${confirmingDelete ? "confirm-delete" : ""}`}>
          {confirmingDelete ? <><strong>Delete {selected.size} selected entr{selected.size === 1 ? "y" : "ies"}?</strong><span /><button onClick={() => setConfirmingDelete(false)}>Cancel</button><button className="danger-action" onClick={deleteSelected}>Delete</button></> : <><strong>{selected.size ? `${selected.size} selected` : "Tap entries to select"}</strong><span />{selected.size > 0 && <><button onClick={() => { setCopyDate(moveDate(date, 1)); setModal("copy"); }}>Copy</button><button className="danger-text" onClick={() => setConfirmingDelete(true)}>Delete</button></>}<button onClick={() => { setSelecting(false); setSelected(new Set()); }}>Done</button></>}
        </div>}
        {loading ? <div className="empty-state"><p>Opening today’s page…</p></div> : <div className={`meal-log ${dragging ? "is-dragging" : ""}`} role="table" aria-label="Food log by meal">
          <div className="food-table-header" role="row">
            <span>Food</span>
            {LOG_COLUMNS.map((column) => <span key={column.long}><span className="column-long">{column.long}</span><span className="column-short">{column.short}</span></span>)}
          </div>
          {MEALS.map((meal) => {
            const entries = day.entries.filter((entry) => entry.meal === meal.id);
            const mealNutrition = totalNutrition(entries);
            const collapsed = collapsedMeals.has(meal.id);
            return <section className="meal-section" key={meal.id} aria-labelledby={`meal-${meal.id}`}>
              <header className="meal-heading" data-meal-drop data-meal={meal.id} onDragOver={(event) => { event.preventDefault(); const next: DropTarget = { meal: meal.id, position: "end" }; dropTargetRef.current = next; setDropTarget(next); }} onDrop={(event) => { event.preventDefault(); finishDrag(event.dataTransfer.getData("text/plain") || dragging || "", dropTargetRef.current); }}>
                <div className="meal-primary">
                  <h3 id={`meal-${meal.id}`}><button className="meal-toggle" onClick={() => toggleMeal(meal.id)} aria-expanded={!collapsed} aria-controls={`meal-entries-${meal.id}`} title={`${collapsed ? "Expand" : "Collapse"} ${meal.label}`}><span className="meal-chevron"><MealChevronIcon expanded={!collapsed} /></span><span>{meal.label}</span></button></h3>
                  <div className="meal-actions"><button className="meal-repeat" onClick={() => repeatMeal(meal.id)} aria-label={`Repeat yesterday's ${meal.label}`} title={`Repeat yesterday's ${meal.label}`}><RepeatIcon /></button><button className="meal-add" onClick={() => openAdd(meal.id)} aria-label={`Add food to ${meal.label}`} title={`Add food to ${meal.label}`}><PlusIcon /></button></div>
                </div>
                <MealTotals totals={mealNutrition} />
              </header>
              <div id={`meal-entries-${meal.id}`} hidden={collapsed} className={`meal-entries ${dropTarget?.meal === meal.id && dropTarget.position === "end" ? "drop-at-end" : ""}`}>
                {entries.map((entry) => {
                  const indicator = dropTarget?.entryId === entry.id ? `drop-${dropTarget.position}` : "";
                  return <div className={`food-row ${selecting ? "is-selecting" : ""} ${reordering ? "is-reordering" : ""} ${selected.has(entry.id) ? "is-selected" : ""} ${dragging === entry.id ? "is-dragged" : ""} ${indicator}`} role="row" key={entry.id} data-drop-entry={entry.id} data-meal={meal.id} draggable={reordering}
                    onDragStart={(event) => { if (!reordering) return; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", entry.id); setDragging(entry.id); }}
                    onDragEnd={() => reordering && finishDrag(entry.id)}
                    onPointerDown={(event) => { if (reordering && event.pointerType !== "mouse") { event.preventDefault(); setDragging(entry.id); } }}
                    onDragOver={(event) => {
                      if (!reordering) return;
                      event.preventDefault();
                      const rect = event.currentTarget.getBoundingClientRect();
                      const pointerY = Number.isFinite(event.clientY) ? event.clientY : rect.top;
                      const next: DropTarget = { meal: meal.id, entryId: entry.id, position: pointerY < rect.top + rect.height / 2 ? "before" : "after" };
                      dropTargetRef.current = next; setDropTarget(next);
                    }}
                    onDrop={(event) => { event.preventDefault(); finishDrag(event.dataTransfer.getData("text/plain") || dragging || "", dropTargetRef.current); }}>
                    {selecting && <label className="check-cell" onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={selected.has(entry.id)} onChange={() => toggleSelected(entry.id)} aria-label={`Select ${entry.name}`} /></label>}
                    <button className="food-entry-main" onClick={() => selecting ? toggleSelected(entry.id) : !reordering && edit(entry)} aria-label={selecting ? `Select ${entry.name}` : reordering ? `Reorder ${entry.name}` : `Edit ${entry.name}`}>
                      <span className="food-name-cell"><FoodVisual value={entry.icon} className="food-icon" label={entry.name} /><span className="food-name-text">{entry.name}</span></span>
                      <span>{fmt(entry.amount)}</span><span>{fmt(entry.protein)}</span><span>{fmt(entry.fat)}</span><span>{fmt(entry.carbs)}</span><span className="energy-cell">{fmt(entry.calories, true)}</span>
                    </button>
                  </div>;
                })}
              </div>
            </section>;
          })}
        </div>}
      </section>
    </main>

    {modal === "add" && <AddFoodModal date={date} foods={foods} entry={editingEntry} initialMeal={addMeal} onClose={() => { setModal(null); setEditingEntry(undefined); }} reportError={reportError} />}
    {modal === "targets" && <TargetsForm initial={targets} onSave={saveTargets} onClose={() => setModal(null)} />}
    {modal === "preferences" && <PreferencesForm initial={dayRolloverMinutes} onSave={saveDayRollover} onClose={() => setModal(null)} />}
    {modal === "copy" && <Modal title="Copy selected entries" onClose={() => setModal(null)}><div className="stack-form"><p className="form-note">The selected entries will be appended to the destination day in their current meal sections.</p><label><span>Destination date</span><input type="date" value={copyDate} onChange={(e) => setCopyDate(e.target.value)} /></label><footer className="form-actions"><button className="quiet-button" onClick={() => setModal(null)}>Cancel</button><button className="primary-button" onClick={copySelected}>Copy {selected.size} {selected.size === 1 ? "entry" : "entries"}</button></footer></div></Modal>}
    {modal === "export" && <ExportModal date={date} onClose={() => setModal(null)} reportError={reportError} />}
    {modal === "connection" && <Modal title="Connection" onClose={() => setModal(null)}><ConnectionForm initial={session} onCancel={() => setModal(null)} onConnected={(connected) => { backendSession.configure(connected, requireLogin); setSession(connected); setModal(null); }} /><div className="connection-signout">
      {syncStatus.pendingCount > 0 && <p className="signout-warning" role="alert">{syncStatus.pendingCount} change{syncStatus.pendingCount === 1 ? " has" : "s have"} not been uploaded yet. Signing out deletes the copy on this device.</p>}
      <button className="danger-text" onClick={() => void signOut()}>Sign out of this device</button>
    </div></Modal>}
    {modal === "settings" && <Modal title="Settings" onClose={() => setModal(null)}><div className="settings-list">
      {update === "ready" && <button className="settings-update" onClick={() => void installUpdate()}>
        <span>Update Calorie Logger</span><small>A new version is downloaded and ready. This reloads the app.</small>
      </button>}
      {update === "downloading" && <button className="settings-update" disabled>
        <span>Downloading an update…</span><small>You can carry on; it will be offered when it is ready.</small>
      </button>}
      <button onClick={() => setModal("targets")}><span>Nutrition targets</span><small>Set energy and macro goals</small></button>
      <button onClick={() => setModal("preferences")}><span>Preferences</span><small>General app behaviour</small></button>
      <button disabled={!day.entries.length} onClick={() => { setSelecting(true); setReordering(false); setSelected(new Set()); setModal(null); }}><span>Select entries</span><small>Copy or delete several foods</small></button>
      <button disabled={!day.entries.length} onClick={() => { setReordering(true); setSelecting(false); setSelected(new Set()); setModal(null); }}><span>Reorder entries</span><small>Drag foods within or between meals</small></button>
      <button onClick={() => setModal("export")}><span>Export data</span><small>Save a JSON backup</small></button>
      <button onClick={() => setModal("sync")}><span>Sync</span><small>{syncStatus.pendingCount ? `${syncStatus.pendingCount} change${syncStatus.pendingCount === 1 ? "" : "s"} waiting to upload` : "Offline copy and upload status"}</small></button>
      <button onClick={() => setModal("connection")}><span>Connection</span><small>Account and server settings</small></button>
      <button onClick={() => setModal("credits")}><span>Picture credits</span><small>Who made the food pictures</small></button>
      <button onClick={() => setModal("about")}><span>About</span><small>Version {appVersion}{macApp && !isNativeHost() ? " · Mac app available" : ""}</small></button>
      <button className="settings-danger" onClick={() => setModal("reset")}><span>Reset app data</span><small>Delete everything and restore the default foods</small></button>
    </div></Modal>}
    {modal === "reset" && <Modal title="Reset app data" onClose={() => setModal(null)}><ResetForm
      foodCount={foods.length}
      resetting={resetting}
      onCancel={() => setModal(null)}
      onConfirm={async () => {
        setResetting(true);
        try {
          await repository.resetData();
          setSelected(new Set());
          setSelecting(false);
          setReordering(false);
          setModal(null);
        } catch (error) { reportError(error); }
        finally { setResetting(false); }
      }}
    /></Modal>}
    {modal === "credits" && <Modal title="Picture credits" onClose={() => setModal(null)}><PictureCredits /></Modal>}
    {modal === "about" && <Modal title="About Calorie Logger" onClose={() => setModal(null)}>
      <AboutPanel update={update} macApp={macApp} onUpdate={() => void installUpdate()} />
    </Modal>}
    {modal === "sync" && <Modal title="Sync" onClose={() => setModal(null)}><SyncPanel status={syncStatus} persistent={snapshot.persistent} onSyncNow={() => void syncEngine.syncNow(true)} onDismissConflicts={() => syncEngine.acknowledge()} /></Modal>}
    {error && <div className="toast" role="alert"><span>{error}</span><button onClick={() => setError(undefined)}>×</button></div>}
  </div>;
}
