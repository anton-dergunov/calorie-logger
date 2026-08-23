import modelURL from "./assets/potion/potion-base-2m.q8.bin?url";
import testModelURL from "./assets/potion/potion-base-2m.q8.bin?inline";
import vocabularyURL from "./assets/potion/vocab.txt?url";
import testVocabularyText from "./assets/potion/vocab.txt?raw";
import type { FoodVisualCatalogItem } from "./foodVisuals";

type PotionModel = {
  dimensions: number;
  scales: Float32Array;
  vectors: Int8Array;
  vocabulary: Map<string, number>;
};

export type RankedFoodVisual = { item: FoodVisualCatalogItem; score: number };

let modelPromise: Promise<PotionModel> | undefined;
let catalogEmbeddingsPromise: Promise<Float32Array[]> | undefined;

function decodeDataURL(url: string): ArrayBuffer {
  const comma = url.indexOf(",");
  if (comma < 0) throw new Error("The bundled Potion model is invalid.");
  const metadata = url.slice(0, comma);
  const payload = url.slice(comma + 1);
  if (!metadata.includes(";base64")) return new TextEncoder().encode(decodeURIComponent(payload)).buffer;
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

async function loadModelBuffer(): Promise<ArrayBuffer> {
  if (import.meta.env.MODE === "test") return decodeDataURL(testModelURL);
  const response = await fetch(modelURL);
  if (!response.ok) throw new Error("The bundled Potion model could not be loaded.");
  return response.arrayBuffer();
}

async function loadVocabularyText(): Promise<string> {
  if (import.meta.env.MODE === "test") return testVocabularyText;
  const response = await fetch(vocabularyURL);
  if (!response.ok) throw new Error("The bundled Potion vocabulary could not be loaded.");
  return response.text();
}

function loadPotion(): Promise<PotionModel> {
  modelPromise ??= Promise.all([loadModelBuffer(), loadVocabularyText()]).then(([buffer, vocabularyText]) => {
    const header = new Uint8Array(buffer, 0, 8);
    if (String.fromCharCode(...header.slice(0, 5)) !== "PTNQ8") throw new Error("The bundled Potion model has an unknown format.");
    const view = new DataView(buffer);
    const rows = view.getUint32(8, true);
    const dimensions = view.getUint32(12, true);
    const scales = new Float32Array(buffer, 16, rows);
    const vectors = new Int8Array(buffer, 16 + rows * 4, rows * dimensions);
    const tokens = vocabularyText.trimEnd().split("\n");
    if (tokens.length !== rows) throw new Error("The bundled Potion vocabulary does not match its model.");
    return { dimensions, scales, vectors, vocabulary: new Map(tokens.map((token, index) => [token, index])) };
  });
  return modelPromise;
}

function isPunctuation(character: string): boolean {
  return /[\p{P}\p{S}]/u.test(character);
}

function basicTokens(text: string): string[] {
  const normalized = text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[\u0000\uFFFD]/g, "");
  const tokens: string[] = [];
  let current = "";
  for (const character of normalized) {
    if (/\s/u.test(character)) {
      if (current) tokens.push(current);
      current = "";
    } else if (isPunctuation(character)) {
      if (current) tokens.push(current);
      tokens.push(character);
      current = "";
    } else {
      current += character;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

export function potionTokenIDs(text: string, vocabulary: Map<string, number>): number[] {
  const unknownID = vocabulary.get("[UNK]");
  const result: number[] = [];
  for (const token of basicTokens(text)) {
    if (token.length > 100) continue;
    let start = 0;
    let failed = false;
    const pieces: number[] = [];
    while (start < token.length) {
      let end = token.length;
      let found: number | undefined;
      while (start < end) {
        const candidate = `${start > 0 ? "##" : ""}${token.slice(start, end)}`;
        found = vocabulary.get(candidate);
        if (found !== undefined) break;
        end -= 1;
      }
      if (found === undefined) {
        failed = true;
        break;
      }
      pieces.push(found);
      start = end;
    }
    if (!failed) result.push(...pieces.filter((id) => id !== unknownID));
  }
  return result;
}

function embedWithModel(text: string, model: PotionModel): Float32Array {
  const ids = potionTokenIDs(text, model.vocabulary);
  const result = new Float32Array(model.dimensions);
  if (!ids.length) return result;
  for (const id of ids) {
    const scale = model.scales[id];
    const offset = id * model.dimensions;
    for (let dimension = 0; dimension < model.dimensions; dimension += 1) {
      result[dimension] += model.vectors[offset + dimension] * scale;
    }
  }
  let norm = 0;
  for (let dimension = 0; dimension < result.length; dimension += 1) {
    result[dimension] /= ids.length;
    norm += result[dimension] ** 2;
  }
  norm = Math.sqrt(norm);
  if (norm) for (let dimension = 0; dimension < result.length; dimension += 1) result[dimension] /= norm;
  return result;
}

function cosine(left: Float32Array, right: Float32Array): number {
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result += left[index] * right[index];
  return result;
}

export async function rankFoodVisuals(query: string, catalog: FoodVisualCatalogItem[]): Promise<RankedFoodVisual[]> {
  const model = await loadPotion();
  const queryEmbedding = embedWithModel(query, model);
  catalogEmbeddingsPromise ??= Promise.resolve(catalog.map((item) => embedWithModel(`${item.label}. ${item.keywords.join(", ")}`, model)));
  const embeddings = await catalogEmbeddingsPromise;
  return catalog.map((item, index) => ({ item, score: cosine(queryEmbedding, embeddings[index]) }))
    .sort((left, right) => right.score - left.score || left.item.label.localeCompare(right.item.label));
}

export function lexicalFoodVisuals(query: string, catalog: FoodVisualCatalogItem[]): RankedFoodVisual[] {
  const tokens = basicTokens(query).filter((token) => token.length > 1);
  if (!tokens.length) return catalog.map((item) => ({ item, score: 0 }));
  return catalog.map((item) => {
    const label = item.label.toLowerCase();
    const all = tokens.every((token) => item.searchText.includes(token));
    const score = label === query.toLowerCase() ? 4 : label.startsWith(query.toLowerCase()) ? 3 : all ? 2 : tokens.some((token) => item.searchText.includes(token)) ? 1 : 0;
    return { item, score };
  }).filter(({ score }) => score > 0).sort((left, right) => right.score - left.score || left.item.label.localeCompare(right.item.label));
}
