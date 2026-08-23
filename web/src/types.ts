export type FoodUnit = "g" | "ml" | "item";
export type Meal = "breakfast" | "lunch" | "dinner" | "snack";

export interface EntryPlacement {
  id: string;
  meal: Meal;
}

export interface Nutrition {
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
}

export type ExternalFoodSource = "openFoodFacts" | "cofid";

export interface FoodSource {
  provider: ExternalFoodSource;
  id: string;
  label: string;
  url: string;
}

/**
 * Replication metadata carried by every stored record.
 *
 * `editedAt`/`editedBy` are the writing device's clock and identity and decide which version of
 * a record survives a merge. `revision` is assigned by the server and is only ever read as a
 * pull cursor; a record written locally and not yet accepted carries `revision: 0`. `deleted`
 * is a tombstone, because a device that has been offline has to be able to learn that something
 * was removed.
 */
export interface SyncFields {
  deleted: boolean;
  createdAt: string;
  editedAt: string;
  editedBy: string;
  revision: number;
}

export interface Food extends Nutrition, SyncFields {
  id: string;
  name: string;
  icon: string;
  basisAmount: number;
  unit: FoodUnit;
  source: FoodSource | null;
  /**
   * Something eaten once, kept out of the catalogue.
   *
   * It is an ordinary food in every other way — entries reference it, edits reach every entry
   * that uses it, and it replicates like anything else. It is simply never offered in the food
   * list, and it is tombstoned once no entry references it any more.
   */
  oneOff: boolean;
}

export type FoodInput = Omit<Food, "id" | keyof SyncFields>;

/** The stored form of a log entry. Presentation and nutrition are derived from the saved food. */
export interface StoredEntry extends SyncFields {
  id: string;
  foodId: string;
  date: string;
  meal: Meal;
  sortIndex: number;
  amount: number;
}

export interface Targets {
  calories: number | null;
  protein: number | null;
  fat: number | null;
  carbs: number | null;
}

export interface StoredTargets extends SyncFields {
  id: string;
  targets: Targets;
  /** Minutes after local midnight a new day begins. 0 (the default) is plain midnight. */
  dayRolloverMinutes: number;
  /** Percentage of a daily target above which a food is flagged in the log. 0 turns flagging off. */
  contributionThreshold: number;
}

export interface FoodUsage {
  entryCount: number;
  /** The amount of the most recently logged entry for this food, so logging it again can offer it. */
  lastAmount: number | null;
}

export interface ExternalNutritionCandidate {
  unit: FoodUnit;
  basisAmount: number;
  calories: number | null;
  protein: number | null;
  fat: number | null;
  carbs: number | null;
}

export interface ExternalFoodResult {
  id: string;
  source: FoodSource;
  name: string;
  photoURL?: string | null;
  detail?: string | null;
  preferredUnit: FoodUnit;
  nutritionCandidates: ExternalNutritionCandidate[];
  warnings?: string[];
}

/**
 * What an estimate is made from: words, a photograph, or both.
 *
 * With both, the picture says what the food is and the words say how much of it, which is how
 * "half of this" or "moderate portion" reaches the model at all.
 */
export interface FoodEstimateRequest {
  description?: string;
  image?: { mimeType: string; data: string };
}

/**
 * A portion estimated from a language model's own knowledge of what was described or shown.
 *
 * The grams are for the whole portion, not for 100 g, so it becomes a food defined per item.
 * Energy is not carried: it is derived from the macros like every other food, so the two can
 * never disagree.
 */
export interface FoodEstimate {
  recognised: boolean;
  name: string;
  /** What portion the estimate assumed, in words, so an unstated quantity is never silent. */
  portion: string;
  protein: number;
  fat: number;
  carbs: number;
  confidence: "high" | "medium" | "low";
  note: string | null;
}

export interface ExternalFoodSearchError {
  source: ExternalFoodSource;
  code: "disabled" | "rate_limited" | "temporarily_unavailable";
  message: string;
  retryable: boolean;
}

export interface ExternalFoodSearchResponse {
  results: ExternalFoodResult[];
  errors: ExternalFoodSearchError[];
}

/** A log entry as the interface shows it: always derived from the current saved food. */
export interface LogEntry extends Nutrition {
  id: string;
  foodId: string;
  date: string;
  name: string;
  icon: string;
  amount: number;
  basisAmount: number;
  unit: FoodUnit;
  sortIndex: number;
  meal: Meal;
  createdAt: string;
  editedAt: string;
}

export interface DayData {
  date: string;
  entries: LogEntry[];
  totals: Nutrition;
}

export type ExportRequest =
  | { scope: "all" }
  | { scope: "range"; startDate: string; endDate: string };

export interface ExportResult {
  status: "saved" | "cancelled";
  path?: string;
}

export interface ExportDocument {
  schemaVersion: number;
  exportedAt: string;
  scope: "all" | "range";
  targets: Targets;
  foods: Food[];
  entries: LogEntry[];
}

/** The records exchanged with the server in one direction of a sync. */
export interface SyncChanges {
  foods: Food[];
  entries: StoredEntry[];
  settings: StoredTargets | null;
}

export interface SyncRejection {
  collection: "foods" | "entries" | "settings";
  id: string;
  reason: "superseded" | "invalid";
  message?: string;
}

export interface SyncResponse {
  schemaVersion: number;
  serverTime: string;
  /** Identifies the server database the cursor belongs to. A change means it was rebuilt. */
  datasetId?: string;
  cursor: number;
  changes: SyncChanges;
  rejected: SyncRejection[];
}

export const emptyNutrition = (): Nutrition => ({
  calories: 0,
  protein: 0,
  fat: 0,
  carbs: 0
});

export const emptyTargets = (): Targets => ({
  calories: null,
  protein: null,
  fat: null,
  carbs: null
});

export function scaledNutrition(food: Nutrition & { basisAmount: number }, amount: number): Nutrition {
  const scale = amount / food.basisAmount;
  return {
    calories: food.calories * scale,
    protein: food.protein * scale,
    fat: food.fat * scale,
    carbs: food.carbs * scale
  };
}

export function sumNutrition(entries: Nutrition[]): Nutrition {
  return entries.reduce(
    (sum, item) => ({
      calories: sum.calories + item.calories,
      protein: sum.protein + item.protein,
      fat: sum.fat + item.fat,
      carbs: sum.carbs + item.carbs
    }),
    emptyNutrition()
  );
}

/**
 * A food taking a fifth of a daily target is the point at which nutrition labelling calls a serving
 * a high source of something you are trying to limit, and it is a sensible place to start looking.
 */
export const DEFAULT_CONTRIBUTION_THRESHOLD = 20;

/** The macros a food can be flagged for. Protein is excluded: eating more of it is not the problem. */
export const FLAGGED_MACROS = ["fat", "carbs"] as const;
export type FlaggedMacro = (typeof FLAGGED_MACROS)[number];

/** 0 is no flag; 1 to 3 are increasing shares of a daily target. */
export type ContributionLevel = 0 | 1 | 2 | 3;

export interface FoodContribution {
  /** How many of the day's entries this food accounts for. */
  count: number;
  shares: Record<FlaggedMacro, number | null>;
  levels: Record<FlaggedMacro, ContributionLevel>;
}

/**
 * One preference tunes the whole scale: the steps are multiples of the flagging threshold, so
 * raising the threshold widens every band with it rather than only moving the first one.
 */
export function contributionLevel(share: number | null, thresholdPercent: number): ContributionLevel {
  if (share === null || !Number.isFinite(share) || thresholdPercent <= 0) return 0;
  // Banded on the whole percentage the interface shows, not on the raw ratio, so a food described
  // as taking 35% of a target is never tinted as though it took 34.9999%.
  const percent = Math.round(share * 100);
  if (percent < thresholdPercent) return 0;
  if (percent < thresholdPercent * 1.75) return 1;
  if (percent < thresholdPercent * 2.5) return 2;
  return 3;
}

/**
 * A food's share of the day's budget for a macro, summed over every entry of that food rather than
 * judged one portion at a time. A light food eaten repeatedly is then weighed as the block it
 * really is, instead of hiding behind the individual servings it was logged as.
 *
 * The denominator is the target, never the running day total: a share decided against what has been
 * eaten so far would make the first entry of the day the whole of it, and would restate every
 * earlier row on each new one.
 */
export function foodContributions(entries: LogEntry[], targets: Targets, thresholdPercent: number): Map<string, FoodContribution> {
  const totals = new Map<string, { count: number; fat: number; carbs: number }>();
  for (const entry of entries) {
    const running = totals.get(entry.foodId) ?? { count: 0, fat: 0, carbs: 0 };
    running.count += 1;
    running.fat += entry.fat;
    running.carbs += entry.carbs;
    totals.set(entry.foodId, running);
  }
  const contributions = new Map<string, FoodContribution>();
  for (const [foodId, total] of totals) {
    const shares = {} as Record<FlaggedMacro, number | null>;
    const levels = {} as Record<FlaggedMacro, ContributionLevel>;
    for (const macro of FLAGGED_MACROS) {
      const target = targets[macro];
      shares[macro] = target !== null && target > 0 ? total[macro] / target : null;
      levels[macro] = contributionLevel(shares[macro], thresholdPercent);
    }
    contributions.set(foodId, { count: total.count, shares, levels });
  }
  return contributions;
}

/**
 * Last-writer-wins: the later wall-clock write survives, and when two devices write in the same
 * millisecond the device id decides, so every replica reaches the same answer independently.
 */
export function supersedes(incoming: SyncFields, stored: SyncFields | undefined): boolean {
  if (!stored) return true;
  if (incoming.editedAt !== stored.editedAt) return incoming.editedAt > stored.editedAt;
  return incoming.editedBy > stored.editedBy;
}
