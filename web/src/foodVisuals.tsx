import type { CSSProperties } from "react";
import catalogData from "./data/pictures.yaml";

type CatalogRecord = {
  id: string;
  label: string;
  keywords: string[];
};

export type FoodVisualCatalogItem = CatalogRecord & {
  value: string;
  searchText: string;
  source: string;
};

const pictureModules = import.meta.glob<string>("./assets/pictures/*.webp", {
  eager: true,
  query: "?url",
  import: "default"
});

const sourceByID = new Map(
  Object.entries(pictureModules).map(([path, source]) => [path.split("/").pop()?.replace(/\.webp$/, ""), source])
);

/** The plate: what a food gets until a more specific picture fits it. */
export const DEFAULT_FOOD_VISUAL = "pic:plate";

export const foodVisualCatalog: FoodVisualCatalogItem[] = (catalogData as CatalogRecord[]).map((item) => ({
  ...item,
  value: `pic:${item.id}`,
  searchText: [item.label, ...item.keywords].join(" ").toLowerCase(),
  source: sourceByID.get(item.id) ?? ""
}));

export const foodVisualByValue = new Map(foodVisualCatalog.map((item) => [item.value, item]));

export function isDefaultFoodVisual(value: string): boolean {
  return !value || value === DEFAULT_FOOD_VISUAL;
}

export function FoodVisual({ value, className, label, style }: {
  value: string;
  className?: string;
  label?: string;
  style?: CSSProperties;
}) {
  const catalogItem = foodVisualByValue.get(value) ?? foodVisualByValue.get(DEFAULT_FOOD_VISUAL);
  const accessibleLabel = label ?? catalogItem?.label ?? "Food picture";

  return <span
    className={`food-visual ${className ?? ""}`.trim()}
    role="img"
    aria-label={accessibleLabel}
    style={style}
  >{catalogItem?.source && <img src={catalogItem.source} alt="" />}</span>;
}

export function foodVisualSource(item: FoodVisualCatalogItem): string {
  return item.source;
}
