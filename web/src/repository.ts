import { estimateFood as requestFoodEstimate, externalFoods, macRelease as requestMacRelease, serverDownloadURL } from "./api";
import { localStore, type Preferences } from "./localStore";
import type {
  DayData, EntryPlacement, ExportDocument, ExportRequest, ExternalFoodResult,
  ExternalFoodSearchResponse, Food, FoodEstimate, FoodEstimateRequest, FoodInput, FoodUsage, Meal, Targets
} from "./types";
import type { MacReleaseInfo } from "./api";

/**
 * Everything the interface can do with the owner's data.
 *
 * Every method here resolves against the local replica, so the interface never waits on, and is
 * never blocked by, a server. Only the two external-catalogue lookups need the network, because
 * searching millions of products is not something a phone can hold.
 */
export interface FoodRepository {
  day(date: string): DayData;
  foodUsage(id: string): FoodUsage;
  dataSummary(): { foodCount: number; entryCount: number };
  exportData(request: ExportRequest): ExportDocument;
  searchExternalFoods(query: string): Promise<ExternalFoodSearchResponse>;
  lookupExternalFood(barcode: string): Promise<ExternalFoodResult | null>;
  /** Nutrition for a portion described in words, photographed, or both, estimated by the server. */
  estimateFood(request: FoodEstimateRequest): Promise<FoodEstimate>;
  saveFood(input: FoodInput, id?: string): Promise<Food>;
  deleteFood(id: string): Promise<void>;
  addEntry(date: string, foodId: string, amount: number, meal: Meal): Promise<void>;
  updateEntry(id: string, date: string, amount: number, meal: Meal, foodId?: string): Promise<void>;
  deleteEntries(ids: string[]): Promise<void>;
  reorderEntries(placements: EntryPlacement[]): Promise<void>;
  copyEntries(ids: string[], destinationDate: string): Promise<void>;
  repeatPreviousMeal(date: string, meal: Meal): Promise<void>;
  saveTargets(targets: Targets): Promise<Targets>;
  /** When a day starts, and how large a share of a target makes a food worth flagging. */
  savePreferences(preferences: Preferences): Promise<Preferences>;
  /** Empties this account on every device and restores the shipped catalogue. */
  resetData(): Promise<void>;
  /** The desktop application this server offers, or null when it has never published one. */
  macRelease(): Promise<MacReleaseInfo | null>;
  /** Turns a server-relative download path into something a link can point at. */
  downloadURL(path: string): string | undefined;
}

class LocalFoodRepository implements FoodRepository {
  day = (date: string) => localStore.day(date);
  foodUsage = (id: string) => localStore.foodUsage(id);
  dataSummary = () => localStore.dataSummary();
  exportData = (request: ExportRequest) => localStore.exportDocument(request);
  searchExternalFoods = (query: string) => externalFoods.search(query);
  lookupExternalFood = (barcode: string) => externalFoods.lookupBarcode(barcode);
  estimateFood = (request: FoodEstimateRequest) => requestFoodEstimate(request);
  saveFood = (input: FoodInput, id?: string) => localStore.saveFood(input, id);
  deleteFood = (id: string) => localStore.deleteFood(id);
  addEntry = (date: string, foodId: string, amount: number, meal: Meal) => localStore.addEntry(date, foodId, amount, meal);
  updateEntry = (id: string, date: string, amount: number, meal: Meal, foodId?: string) => localStore.updateEntry(id, date, amount, meal, foodId);
  deleteEntries = (ids: string[]) => localStore.deleteEntries(ids);
  reorderEntries = (placements: EntryPlacement[]) => localStore.reorderEntries(placements);
  copyEntries = (ids: string[], destinationDate: string) => localStore.copyEntries(ids, destinationDate);
  repeatPreviousMeal = (date: string, meal: Meal) => localStore.repeatPreviousMeal(date, meal);
  saveTargets = (targets: Targets) => localStore.saveTargets(targets);
  savePreferences = (preferences: Preferences) => localStore.savePreferences(preferences);
  resetData = () => localStore.resetToDefaults();
  macRelease = () => requestMacRelease();
  downloadURL = (path: string) => serverDownloadURL(path);
}

export const repository: FoodRepository = new LocalFoodRepository();
export { CalorieLoggerApiError, backendSession } from "./api";
export type { MacReleaseInfo } from "./api";

declare global {
  interface Window {
    calorieLogger?: {
      openAddFood(): void;
      openTargets(): void;
      openExport(): void;
      openConnection(): void;
      jumpToToday(): void;
      refreshNativeSummary(): Promise<void>;
    };
  }
}
