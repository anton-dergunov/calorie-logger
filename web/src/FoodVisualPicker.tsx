import { useEffect, useState } from "react";
import { DEFAULT_FOOD_VISUAL, FoodVisual, foodVisualByValue, foodVisualCatalog, type FoodVisualCatalogItem } from "./foodVisuals";
import { rankFoodVisuals } from "./potion";

export function FoodVisualPicker({ value, foodName, onChange }: {
  value: string;
  foodName: string;
  onChange(value: string): void;
}) {
  const [ranked, setRanked] = useState<FoodVisualCatalogItem[]>(foodVisualCatalog);
  const [ranking, setRanking] = useState(false);
  const suggestions = ranked.filter((item) => item.value !== DEFAULT_FOOD_VISUAL);

  useEffect(() => {
    let active = true;
    const query = foodName.trim();
    if (!query) {
      setRanked(foodVisualCatalog);
      setRanking(false);
      return () => { active = false; };
    }
    setRanking(true);
    rankFoodVisuals(query, foodVisualCatalog).then((results) => {
      if (active) setRanked(results.map(({ item }) => item));
    }).catch(() => {
      if (active) setRanked(foodVisualCatalog);
    }).finally(() => {
      if (active) setRanking(false);
    });
    return () => { active = false; };
  }, [foodName]);

  return <fieldset className="visual-picker">
    <legend>Choose picture</legend>
    <div className="selected-visual-summary">
      <FoodVisual value={value} label={foodName ? `${foodName} picture` : undefined} />
      <span><strong>{foodVisualByValue.get(value)?.label ?? "Fork and knife with plate"}</strong><small>Current picture</small></span>
    </div>
    <button type="button" className={`default-visual-action ${value === DEFAULT_FOOD_VISUAL ? "selected" : ""}`} onClick={() => onChange(DEFAULT_FOOD_VISUAL)} aria-label="Use default picture" aria-pressed={value === DEFAULT_FOOD_VISUAL}>
      <FoodVisual value={DEFAULT_FOOD_VISUAL} label="Default food picture" />
      <span><strong>Use default picture</strong><small>A clear generic choice when no specific picture fits</small></span>
    </button>
    <p className="visual-search-meta" aria-live="polite">{ranking ? "Ranking pictures from the food name…" : `All ${foodVisualCatalog.length} approved pictures`}</p>
    <div className="visual-catalog">
      <div className="visual-grid">
        {suggestions.map((item) => <VisualChoice item={item} selected={value === item.value} onChoose={() => onChange(item.value)} key={item.value} />)}
      </div>
    </div>
  </fieldset>;
}

function VisualChoice({ item, selected, onChoose }: { item: FoodVisualCatalogItem; selected: boolean; onChoose(): void }) {
  return <button
    type="button"
    className={selected ? "selected" : ""}
    onClick={onChoose}
    aria-label={`Choose ${item.label} picture`}
    aria-pressed={selected}
  >
    <FoodVisual value={item.value} label={item.label} />
    <span>{item.label}</span>
  </button>;
}
