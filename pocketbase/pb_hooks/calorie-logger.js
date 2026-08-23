const API_ROOT = "/api/calorie-logger/v5";
const API_VERSION = 5;

// Bumped whenever the replicated record shape changes. A client that disagrees is refused a
// merge outright: a stale device writing the current schema's fields is how a replicated store
// gets corrupted, and refusing costs the owner nothing but an app update.
const SCHEMA_VERSION = 3;

// The release this server is running, supplied by the deployment. It names the build in `/health`
// and identifies this application to Open Food Facts, whose terms ask for a contact URL.
function appVersion() { return trimmed($os.getenv("CALORIE_LOGGER_VERSION")) || "0.0.0"; }
function appBuild() { return trimmed($os.getenv("CALORIE_LOGGER_BUILD")) || "0"; }
function userAgent() {
  return "Calorie-Logger/" + appVersion() + " (+https://github.com/anton-dergunov/calorie-logger)";
}

const MEALS = ["breakfast", "lunch", "dinner", "snack"];
const UNITS = ["g", "ml", "item"];
const SOURCES = ["openFoodFacts", "cofid"];
// The approved food pictures, generated from `web/src/data/pictures.yaml` by
// `npm run generate:pictures` so the server and the app can never disagree about what exists.
let approvedPicturesCache = null;
function approvedPictures() {
  if (approvedPicturesCache) return approvedPicturesCache;
  const path = $os.getenv("CALORIE_LOGGER_PICTURES_PATH") || "pb_hooks/data/food-pictures.json";
  const document = JSON.parse(toString($os.readFile(path)));
  const approved = {};
  (document.pictures || []).forEach((id) => { approved["pic:" + id] = true; });
  approvedPicturesCache = { approved: approved, count: (document.pictures || []).length };
  return approvedPicturesCache;
}

const EMPTY_TARGETS = { calories: null, protein: null, fat: null, carbs: null };
const TARGET_KEYS = ["calories", "protein", "fat", "carbs"];
const ROUTES = {};

function failure(status, code, message, fields) {
  const error = new Error(message);
  error.calorieLoggerStatus = status;
  error.calorieLoggerCode = code;
  error.calorieLoggerFields = fields || undefined;
  return error;
}

function respond(e, data, status) {
  return e.json(status || 200, { data: data });
}

function respondError(e, error) {
  const status = error.calorieLoggerStatus || 500;
  const message = status >= 500 ? "The Calorie Logger server could not complete the request." : String(error.message || error);
  const payload = { code: error.calorieLoggerCode || "server_error", message: message };
  if (error.calorieLoggerFields) payload.fields = error.calorieLoggerFields;
  if (status >= 500) e.app.logger().error("Calorie Logger API request failed", "error", error);
  return e.json(status, { error: payload });
}

function route(method, path, authenticated, handler) {
  ROUTES[method + " " + path] = { authenticated: authenticated, handler: handler };
}

function run(e, method, path) {
  const definition = ROUTES[method + " " + path];
  try {
    if (!definition) throw failure(404, "not_found", "The requested Calorie Logger API route does not exist.");
    if (definition.authenticated && (!e.auth || e.auth.collection().name !== "users")) {
      throw failure(401, "unauthenticated", "Sign in to continue.");
    }
    return definition.handler(e);
  } catch (error) {
    return respondError(e, error);
  }
}

function dispatch(e) {
  const method = String(e.request.method || "GET").toUpperCase();
  const requestPath = String(e.request.url.path || "");
  const relative = requestPath.indexOf(API_ROOT) === 0 ? requestPath.slice(API_ROOT.length) || "/" : requestPath;
  if (ROUTES[method + " " + relative]) return run(e, method, relative);
  return respondError(e, failure(404, "not_found", "The requested Calorie Logger API route does not exist."));
}

function body(e) {
  return e.requestInfo().body || {};
}

function query(e, name) {
  return e.request.url.query().get(name) || "";
}

function ownerID(e) {
  return e.auth.id;
}

function trimmed(value) {
  return String(value == null ? "" : value).trim();
}

function finiteNumber(value, label, positive) {
  const number = Number(value);
  if (!Number.isFinite(number) || (positive ? number <= 0 : number < 0)) {
    throw failure(400, "invalid_input", label + (positive ? " must be greater than zero." : " must be zero or greater."));
  }
  return number;
}

function optionalPositive(value, label) {
  if (value === null || value === undefined || value === "") return null;
  return finiteNumber(value, label, true);
}

function validRolloverMinutes(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number) || number < 0 || number >= 1440) {
    throw failure(400, "invalid_input", "Day rollover time must be a valid time of day.");
  }
  return number;
}

function validDate(value) {
  const date = trimmed(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw failure(400, "invalid_date", "Invalid calendar date.");
  const parsed = new Date(date + "T12:00:00Z");
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw failure(400, "invalid_date", "Invalid calendar date.");
  }
  return date;
}

function validateMeal(value) {
  if (MEALS.indexOf(value) < 0) throw failure(400, "invalid_meal", "Choose a valid meal.");
  return value;
}

function validBarcode(value) {
  const barcode = trimmed(value);
  if (!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(barcode)) {
    throw failure(400, "invalid_barcode", "Scan a valid EAN or UPC product barcode.");
  }
  return barcode;
}

// Merge order is decided by comparing `edited_at` as plain strings, so the format has to be
// exactly what `Date.prototype.toISOString` emits. A timestamp that omitted its milliseconds
// would sort after one that included them ("Z" > "."), silently inverting the winner.
function validInstant(value, label) {
  const instant = trimmed(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(instant)) {
    throw failure(400, "invalid_input", label + " must be an ISO-8601 UTC timestamp with milliseconds.");
  }
  return instant;
}

function validDeviceID(value) {
  const device = trimmed(value);
  if (!/^[a-z0-9]{1,32}$/.test(device)) throw failure(400, "invalid_device", "Provide a valid device identifier.");
  return device;
}

// Clients generate their own record ids so that a record created offline can be edited, moved,
// and deleted before it has ever reached a server. The format is PocketBase's own id format.
function validRecordID(value) {
  const id = trimmed(value);
  if (!/^[a-z0-9]{15}$/.test(id)) throw failure(400, "invalid_id", "Provide a valid record identifier.");
  return id;
}

function validateFoodInput(raw) {
  const input = raw || {};
  const name = trimmed(input.name);
  const icon = trimmed(input.icon);
  const unit = trimmed(input.unit);
  if (!name) throw failure(400, "invalid_food", "Food name is required.");
  if (name.length > 120) throw failure(400, "invalid_food", "Food name is too long.");
  if (!approvedPictures().approved[icon]) throw failure(400, "invalid_food", "Choose an approved food picture.");
  if (UNITS.indexOf(unit) < 0) throw failure(400, "invalid_food", "Choose a valid food unit.");
  const source = input.source || null;
  const sourceProvider = source ? trimmed(source.provider) : "";
  const sourceID = source ? trimmed(source.id) : "";
  if ((sourceProvider || sourceID) && (SOURCES.indexOf(sourceProvider) < 0 || !sourceID || sourceID.length > 120)) {
    throw failure(400, "invalid_food", "Choose a valid food source.");
  }
  const basisAmount = finiteNumber(input.basisAmount, "Nutrition basis", true);
  if (unit === "item" && basisAmount !== 1) throw failure(400, "invalid_food", "Item nutrition must be defined for one item.");
  return {
    name: name,
    icon: icon,
    basisAmount: basisAmount,
    unit: unit,
    oneOff: Boolean(input.oneOff),
    sourceProvider: sourceProvider || null,
    sourceID: sourceID || null,
    calories: finiteNumber(input.calories, "Calories", false),
    protein: finiteNumber(input.protein, "Protein", false),
    fat: finiteNumber(input.fat, "Fat", false),
    carbs: finiteNumber(input.carbs, "Carbohydrates", false),
  };
}

function sourceJSON(provider, id) {
  if (!provider || !id) return null;
  if (provider === "openFoodFacts") return {
    provider: provider, id: id, label: "Open Food Facts",
    url: "https://world.openfoodfacts.org/product/" + encodeURIComponent(id),
  };
  return {
    provider: provider, id: id, label: "CoFID 2021",
    url: "https://www.gov.uk/government/publications/composition-of-foods-integrated-dataset-cofid",
  };
}

function records(app, collection, filter, sort, limit, params) {
  return app.findRecordsByFilter(collection, filter, sort || "", limit || 0, 0, params || {});
}

function firstRecord(app, collection, filter, params) {
  try {
    return app.findFirstRecordByFilter(collection, filter, params);
  } catch (_) {
    return null;
  }
}

/* --------------------------------- replication --------------------------------- */

function syncFieldsJSON(record) {
  return {
    deleted: record.getBool("deleted"),
    createdAt: record.getString("created_at"),
    editedAt: record.getString("edited_at"),
    editedBy: record.getString("edited_by"),
    revision: record.getInt("revision"),
  };
}

function foodJSON(record) {
  return {
    id: record.id,
    name: record.getString("name"),
    icon: record.getString("icon"),
    basisAmount: record.getFloat("basis_amount"),
    unit: record.getString("unit"),
    oneOff: record.getBool("one_off"),
    source: sourceJSON(record.getString("source_provider"), record.getString("source_id")),
    calories: record.getFloat("calories"),
    protein: record.getFloat("protein"),
    fat: record.getFloat("fat"),
    carbs: record.getFloat("carbs"),
    ...syncFieldsJSON(record),
  };
}

function entryJSON(record) {
  return {
    id: record.id,
    foodId: record.getString("food"),
    date: record.getString("log_date"),
    meal: record.getString("meal"),
    sortIndex: record.getInt("sort_index"),
    amount: record.getFloat("amount"),
    ...syncFieldsJSON(record),
  };
}

function targetsJSON(settings) {
  if (!settings) return { ...EMPTY_TARGETS };
  const targets = {};
  TARGET_KEYS.forEach((key) => {
    targets[key] = settings.getBool("has_" + key) ? settings.getFloat(key) : null;
  });
  return targets;
}

function settingsJSON(record) {
  if (!record) return null;
  return {
    id: record.id,
    targets: targetsJSON(record),
    dayRolloverMinutes: record.getInt("day_rollover_minutes"),
    ...syncFieldsJSON(record),
  };
}

// The owner's merge sequence. Every applied write takes the next value, and clients pull
// everything above the cursor they last saw.
function sequenceRecord(app, owner) {
  const existing = firstRecord(app, "sync_state", "owner = {:owner}", { owner: owner });
  if (existing) return existing;
  const record = new Record(app.findCollectionByNameOrId("sync_state"));
  record.set("owner", owner);
  record.set("sequence", 0);
  app.save(record);
  return record;
}

function supersedes(incomingAt, incomingBy, storedAt, storedBy) {
  if (incomingAt !== storedAt) return incomingAt > storedAt;
  return incomingBy > storedBy;
}

// Applies one incoming record under last-writer-wins and returns what happened, so the caller
// can tell the pushing device which of its changes lost.
//
// A record that fails validation is skipped rather than failing the whole batch: one bad row
// must never be able to wedge a device's queue permanently.
function mergeRecord(context, collection, existing, payload, assign) {
  const editedAt = validInstant(payload.editedAt, "Change timestamp");
  let record = existing;
  if (record) {
    const storedAt = record.getString("edited_at");
    const storedBy = record.getString("edited_by");
    if (editedAt === storedAt && context.device === storedBy) return { status: "current", record: record };
    if (!supersedes(editedAt, context.device, storedAt, storedBy)) return { status: "superseded", record: record };
  } else {
    record = new Record(context.app.findCollectionByNameOrId(collection));
    record.set("owner", context.owner);
    record.set("created_at", validInstant(payload.createdAt, "Creation timestamp"));
  }
  assign(record);
  record.set("deleted", payload.deleted === true);
  record.set("edited_at", editedAt);
  record.set("edited_by", context.device);
  context.sequence += 1;
  record.set("revision", context.sequence);
  context.app.save(record);
  return { status: "applied", record: record };
}

// Client-generated ids are random, but a record id is still the primary key for the whole
// database. Refuse an id that already belongs to someone else instead of letting the insert
// fail as a server error.
function ownedOrFree(context, collection, id) {
  const owned = firstRecord(context.app, collection, "id = {:id} && owner = {:owner}", { id: id, owner: context.owner });
  if (owned) return owned;
  if (firstRecord(context.app, collection, "id = {:id}", { id: id })) {
    throw failure(400, "id_conflict", "That record identifier is already in use.");
  }
  return null;
}

function mergeFood(context, payload) {
  const id = validRecordID(payload.id);
  const input = validateFoodInput(payload);
  const existing = ownedOrFree(context, "foods", id);
  return mergeRecord(context, "foods", existing, payload, (record) => {
    if (!existing) record.set("id", id);
    record.set("name", input.name);
    record.set("icon", input.icon);
    record.set("basis_amount", input.basisAmount);
    record.set("unit", input.unit);
    record.set("one_off", input.oneOff);
    record.set("source_provider", input.sourceProvider || "");
    record.set("source_id", input.sourceID || "");
    record.set("calories", input.calories);
    record.set("protein", input.protein);
    record.set("fat", input.fat);
    record.set("carbs", input.carbs);
  });
}

function mergeEntry(context, payload) {
  const id = validRecordID(payload.id);
  const date = validDate(payload.date);
  const meal = validateMeal(payload.meal);
  const amount = finiteNumber(payload.amount, "Amount", true);
  const sortIndex = finiteNumber(payload.sortIndex, "Entry order", false);
  const foodID = validRecordID(payload.foodId);
  const food = firstRecord(context.app, "foods", "id = {:id} && owner = {:owner}", { id: foodID, owner: context.owner });
  if (!food) throw failure(400, "invalid_food_reference", "That log entry references a food this account does not have.");
  const existing = ownedOrFree(context, "log_entries", id);
  return mergeRecord(context, "log_entries", existing, payload, (record) => {
    if (!existing) record.set("id", id);
    record.set("food", food.id);
    record.set("log_date", date);
    record.set("meal", meal);
    record.set("sort_index", Math.round(sortIndex));
    record.set("amount", amount);
  });
}

// Settings are a per-owner singleton, so the stored record is resolved by owner rather than by
// the id a device happens to hold.
function mergeSettings(context, payload) {
  const targets = {};
  TARGET_KEYS.forEach((key) => {
    const label = key === "carbs" ? "Carbohydrates" : key[0].toUpperCase() + key.slice(1);
    targets[key] = optionalPositive((payload.targets || {})[key], label);
  });
  const dayRolloverMinutes = validRolloverMinutes(payload.dayRolloverMinutes);
  const existing = firstRecord(context.app, "user_settings", "owner = {:owner}", { owner: context.owner });
  return mergeRecord(context, "user_settings", existing, payload, (record) => {
    TARGET_KEYS.forEach((key) => {
      record.set("has_" + key, targets[key] !== null);
      record.set(key, targets[key] === null ? 0 : targets[key]);
    });
    record.set("day_rollover_minutes", dayRolloverMinutes);
  });
}

function mergeAll(context, changes, rejected, winners) {
  const note = (collection, id, result) => {
    if (result.status === "superseded") {
      rejected.push({ collection: collection, id: id, reason: "superseded" });
      if (result.record) winners.push({ collection: collection, record: result.record });
    }
  };
  const attempt = (collection, id, apply) => {
    try {
      note(collection, id, apply());
    } catch (error) {
      if (!error.calorieLoggerStatus || error.calorieLoggerStatus >= 500) throw error;
      rejected.push({ collection: collection, id: id, reason: "invalid", message: String(error.message || "") });
    }
  };

  // Foods first: an entry's food relation must already resolve when the entry is saved.
  (changes.foods || []).forEach((payload) => attempt("foods", trimmed(payload.id), () => mergeFood(context, payload)));
  (changes.entries || []).forEach((payload) => attempt("entries", trimmed(payload.id), () => mergeEntry(context, payload)));
  if (changes.settings) attempt("settings", "settings", () => mergeSettings(context, changes.settings));
}

// Everything the pushing device has not seen, plus the current version of anything its push
// lost. Without the latter, a device whose change was superseded by an older revision would
// never receive the version that beat it and would keep re-pushing.
function pullChanges(context, since, winners) {
  const params = { owner: context.owner, since: since };
  const filter = "owner = {:owner} && revision > {:since}";
  const foods = records(context.app, "foods", filter, "revision", 0, params);
  const entries = records(context.app, "log_entries", filter, "revision", 0, params);
  let settings = firstRecord(context.app, "user_settings", filter, params);

  const seen = {};
  foods.concat(entries).forEach((record) => { seen[record.id] = true; });
  winners.forEach((winner) => {
    if (winner.collection === "settings") {
      if (!settings) settings = winner.record;
      return;
    }
    if (seen[winner.record.id]) return;
    seen[winner.record.id] = true;
    (winner.collection === "foods" ? foods : entries).push(winner.record);
  });

  return {
    foods: foods.map(foodJSON),
    entries: entries.map(entryJSON),
    settings: settingsJSON(settings),
  };
}

/* ------------------------------ external foods ------------------------------ */

function normalizedText(value) {
  return trimmed(value).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ");
}

let cofidCache = null;
function cofidFoods() {
  if (cofidCache) return cofidCache;
  const path = $os.getenv("CALORIE_LOGGER_COFID_PATH") || "pb_hooks/data/cofid-2021.json";
  const document = JSON.parse(toString($os.readFile(path)));
  cofidCache = document.foods || [];
  return cofidCache;
}

// CoFID names foods the way a nutritionist writes them down, not the way anyone types them into a
// search box: "Houmous", "Soya milk", "Beans, mung, dahl". Queries are folded towards that before
// matching, or the catalogue silently answers nothing at all for perfectly ordinary foods.
const COFID_SYNONYMS = {
  hummus: "houmous",
  humous: "houmous",
  soya: "soya",
  soy: "soya",
  drink: "milk",
  zucchini: "courgette",
  eggplant: "aubergine",
  arugula: "rocket",
  cilantro: "coriander",
  garbanzo: "chickpeas",
  chickpea: "chick peas",
  chickpeas: "chick peas",
  aubergines: "aubergine",
  crisps: "crisps",
  yogurt: "yoghurt",
};

// "lentils" must find "Lentils" and "Lentil"; nothing more clever than that is wanted here.
function cofidStem(token) {
  if (token.length > 3 && token.slice(-3) === "ies") return token.slice(0, -3) + "y";
  if (token.length > 3 && token.slice(-2) === "es") return token.slice(0, -2);
  if (token.length > 3 && token.slice(-1) === "s") return token.slice(0, -1);
  return token;
}

function cofidTokens(text) {
  const result = [];
  normalizedText(text).split(" ").forEach((raw) => {
    if (!raw) return;
    const token = COFID_SYNONYMS[raw] || raw;
    token.split(" ").forEach((part) => { if (part) result.push(cofidStem(part)); });
  });
  return result;
}

function cofidMatches(tokens, searchable) {
  let matched = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    if (searchable.indexOf(tokens[index]) >= 0) matched += 1;
  }
  return matched;
}

function cofidResult(food) {
  return {
    id: "cofid:" + food.id,
    source: sourceJSON("cofid", food.id),
    name: food.name,
    detail: food.description || null,
    photoURL: null,
    preferredUnit: food.unit,
    nutritionCandidates: [{
      basisAmount: Number(food.basisAmount),
      unit: food.unit,
      calories: Number(food.calories),
      protein: Number(food.protein),
      fat: Number(food.fat),
      carbs: Number(food.carbs),
    }],
  };
}

function searchCoFID(rawQuery) {
  const normalizedQuery = normalizedText(rawQuery);
  const tokens = cofidTokens(rawQuery);
  if (!tokens.length) return [];
  const strict = [];
  const partial = [];
  cofidFoods().forEach((food) => {
    const name = normalizedText(food.name);
    // Stemming the haystack too, so a query token that lost its plural still meets the name.
    const searchable = cofidTokens(name + " " + food.description).join(" ");
    const matched = cofidMatches(tokens, searchable);
    if (!matched) return;
    if (matched < tokens.length) {
      partial.push({ rank: 6 - matched / tokens.length, food: food, name: name, words: name.split(" ").length });
      return;
    }
    // The plainest entry wins. CoFID answers "olive oil" with several fat spreads whose names
    // happen to contain the phrase, and with "Oil, olive"; the latter is what was being asked for,
    // so covering the whole of a short name outranks appearing somewhere in a long one.
    const words = name.split(" ");
    const inName = cofidMatches(tokens, cofidTokens(name).join(" ")) === tokens.length;
    let rank = 6;
    if (name === normalizedQuery) rank = 0;
    else if (name.indexOf(normalizedQuery) === 0) rank = 1;
    else if (inName && words.length <= tokens.length + 2) rank = 2;
    else if (tokens.every((token) => words.some((part) => cofidStem(part).indexOf(token) === 0))) rank = 3;
    else if (name.indexOf(normalizedQuery) >= 0) rank = 4;
    else if (inName) rank = 5;
    strict.push({ rank: rank, food: food, name: name, words: words.length });
  });
  // Every word has to match before a partial match is worth showing; falling back only when the
  // strict pass found nothing keeps a good search clean and stops a bad one returning empty.
  const matches = strict.length ? strict : partial;
  return matches
    .sort((left, right) => left.rank - right.rank || left.words - right.words || left.food.name.localeCompare(right.food.name))
    .slice(0, 10)
    .map((match) => cofidResult(match.food));
}

function offNumber(value) {
  const candidate = value && typeof value === "object" && "value" in value ? value.value : value;
  const number = Number(candidate);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function nutritionValues(nutrients, suffix) {
  const kj = offNumber(nutrients["energy-kj" + suffix]);
  const calories = offNumber(nutrients["energy-kcal" + suffix]);
  return {
    calories: calories === null && kj !== null ? kj / 4.184 : calories,
    protein: offNumber(nutrients["proteins" + suffix]),
    fat: offNumber(nutrients["fat" + suffix]),
    carbs: offNumber(nutrients["carbohydrates" + suffix]),
  };
}

function hasNutrition(values) {
  return values.calories !== null || values.protein !== null || values.fat !== null || values.carbs !== null;
}

function scaledValues(values, scale) {
  const output = {};
  ["calories", "protein", "fat", "carbs"].forEach((key) => {
    output[key] = values[key] === null ? null : values[key] * scale;
  });
  return output;
}

function fillMissingValues(preferred, fallback) {
  const output = {};
  ["calories", "protein", "fat", "carbs"].forEach((key) => {
    output[key] = preferred[key] === null ? fallback[key] : preferred[key];
  });
  return output;
}

function metricUnit(value) {
  const unit = normalizedText(value);
  if (unit === "g" || unit === "gram" || unit === "grams" || unit === "kg" || unit === "kilogram" || unit === "kilograms") return "g";
  if (["ml", "millilitre", "millilitres", "milliliter", "milliliters", "cl", "dl", "l", "litre", "litres", "liter", "liters"].indexOf(unit) >= 0) return "ml";
  return null;
}

function metricQuantity(rawValue, rawUnit, fallbackText) {
  const value = offNumber(rawValue);
  const normalizedUnit = normalizedText(rawUnit);
  if (value !== null && metricUnit(normalizedUnit)) {
    const multiplier = normalizedUnit === "kg" || normalizedUnit.indexOf("kilogram") === 0 ? 1000
      : normalizedUnit === "l" || normalizedUnit.indexOf("lit") === 0 ? 1000
      : normalizedUnit === "cl" ? 10 : normalizedUnit === "dl" ? 100 : 1;
    return { amount: value * multiplier, unit: metricUnit(normalizedUnit) };
  }
  const match = normalizedText(fallbackText).match(/(?:^|\s|\()([0-9]+(?:\.[0-9]+)?)\s*(kg|kilograms?|g|grams?|ml|millilit(?:er|re)s?|cl|dl|l|lit(?:er|re)s?)(?:\b|\))/);
  return match ? metricQuantity(match[1], match[2], "") : null;
}

function explicitItemCount(value) {
  const text = normalizedText(value);
  let match = text.match(/^([0-9]+(?:\.[0-9]+)?)\s*[x×]\s*/);
  if (match) return Number(match[1]);
  const matches = text.matchAll(/(?:^|[\s,(])([0-9]+(?:\.[0-9]+)?)\s+([a-z][a-z -]*?)(?=\s*[),]|$)/g);
  for (const item of matches) {
    const noun = item[2].trim();
    if (!/^(kg|kilograms?|g|grams?|ml|millilit(?:er|re)s?|cl|dl|l|lit(?:er|re)s?)\b/.test(noun)) return Number(item[1]);
  }
  return null;
}

function candidate(unit, basisAmount, values) {
  return {
    unit: unit, basisAmount: basisAmount,
    calories: values.calories, protein: values.protein, fat: values.fat, carbs: values.carbs,
  };
}

function offProduct(product) {
  const nutrients = product.nutriments || {};
  const code = trimmed(product.code);
  const productName = trimmed(product.product_name_en || product.product_name);
  if (!code || !productName) return null;
  const brand = trimmed(product.brands);
  const name = brand && productName.toLowerCase().indexOf(brand.toLowerCase()) < 0 ? brand + " " + productName : productName;
  const productMeasure = metricQuantity(product.product_quantity, product.product_quantity_unit, product.quantity);
  const servingMeasure = metricQuantity(product.serving_quantity, product.serving_quantity_unit, product.serving_size);
  const nutritionMeasure = metricQuantity(undefined, undefined, product.nutrition_data_per);
  const declaredUnit = metricUnit(product.product_quantity_unit) || metricUnit(product.serving_quantity_unit);
  const baseUnit = nutritionMeasure ? nutritionMeasure.unit : productMeasure ? productMeasure.unit : servingMeasure ? servingMeasure.unit : declaredUnit || "g";
  let baseValues = nutritionValues(nutrients, "_100g");
  const servingValues = nutritionValues(nutrients, "_serving");
  if (hasNutrition(baseValues) && servingMeasure && servingMeasure.unit === baseUnit && servingMeasure.amount > 0 && hasNutrition(servingValues)) {
    baseValues = fillMissingValues(baseValues, scaledValues(servingValues, 100 / servingMeasure.amount));
  }
  const byUnit = {};
  if (hasNutrition(baseValues)) byUnit[baseUnit] = candidate(baseUnit, 100, baseValues);
  else if (servingMeasure && hasNutrition(servingValues)) {
    byUnit[servingMeasure.unit] = candidate(servingMeasure.unit, servingMeasure.amount, servingValues);
  }
  const servingCount = explicitItemCount(product.serving_size);
  if (servingCount) {
    let itemValues = scaledValues(servingValues, 1 / servingCount);
    if (servingMeasure && servingMeasure.unit === baseUnit) {
      itemValues = fillMissingValues(itemValues, scaledValues(baseValues, servingMeasure.amount / servingCount / 100));
    }
    if (hasNutrition(itemValues)) byUnit.item = candidate("item", 1, itemValues);
  }
  const packageCount = explicitItemCount(product.quantity);
  if (!byUnit.item && packageCount && productMeasure && productMeasure.unit === baseUnit && hasNutrition(baseValues)) {
    byUnit.item = candidate("item", 1, scaledValues(baseValues, productMeasure.amount / packageCount / 100));
  }
  const photo = trimmed(product.image_front_small_url || product.image_front_thumb_url);
  const preferredUnit = byUnit.item ? "item" : baseUnit;
  const measuredUnits = [nutritionMeasure, productMeasure, servingMeasure]
    .filter(Boolean).map((measure) => measure.unit);
  const warnings = measuredUnits.some((unit) => unit !== measuredUnits[0])
    ? ["Open Food Facts has inconsistent portion units for this product. Check the nutrition basis against the package before saving."]
    : [];
  return {
    id: "off:" + code,
    source: sourceJSON("openFoodFacts", code),
    name: name,
    detail: [trimmed(product.quantity), code].filter(Boolean).join(" · ") || null,
    photoURL: /^https:\/\//i.test(photo) ? photo : null,
    preferredUnit: preferredUnit,
    nutritionCandidates: ["g", "ml", "item"].filter((unit) => byUnit[unit]).map((unit) => byUnit[unit]),
    warnings: warnings,
  };
}

function providerError(code, message, retryable) {
  const error = new Error(message);
  error.providerCode = code;
  error.providerRetryable = retryable;
  return error;
}

function requestOFF(host, search) {
  const fields = "code,product_name,product_name_en,brands,quantity,product_quantity,product_quantity_unit,serving_size,serving_quantity,serving_quantity_unit,nutrition_data_per,image_front_small_url,image_front_thumb_url,nutriments";
  const url = "https://" + host + "/cgi/search.pl?search_terms=" + encodeURIComponent(search) + "&search_simple=1&action=process&json=1&page_size=25&fields=" + encodeURIComponent(fields);
  const response = $http.send({
    url: url,
    method: "GET",
    headers: { Accept: "application/json", "User-Agent": userAgent() },
    // Deliberately shorter than the client's own budget for this request. Open Food Facts stalling
    // must cost the owner a slow search, never the CoFID results this server already has.
    timeout: 8,
  });
  if (response.statusCode === 429) throw providerError("rate_limited", "Open Food Facts is limiting searches. Try again in a minute.", false);
  if (response.statusCode === 408 || response.statusCode >= 500) throw providerError("temporarily_unavailable", "Open Food Facts is temporarily unavailable.", true);
  if (response.statusCode < 200 || response.statusCode >= 300) throw providerError("temporarily_unavailable", "Open Food Facts could not complete this search.", false);
  return (response.json.products || []).map(offProduct).filter(Boolean);
}

function searchOFF(search, attempt) {
  if ($os.getenv("CALORIE_LOGGER_DISABLE_OPEN_FOOD_FACTS") === "1") throw providerError("disabled", "Open Food Facts is disabled for this server run.", false);
  let results;
  try { results = requestOFF(attempt === 0 ? "uk.openfoodfacts.org" : "world.openfoodfacts.org", search); }
  catch (error) {
    if (error.providerCode) throw error;
    throw providerError("temporarily_unavailable", "Open Food Facts is temporarily unavailable.", true);
  }
  const seen = {};
  return results.filter((item) => !seen[item.id] && (seen[item.id] = true)).slice(0, 10);
}

function lookupOFF(barcode) {
  if ($os.getenv("CALORIE_LOGGER_DISABLE_OPEN_FOOD_FACTS") === "1") throw providerError("disabled", "Open Food Facts is disabled on this server.", false);
  const fields = "code,product_name,product_name_en,brands,quantity,product_quantity,product_quantity_unit,serving_size,serving_quantity,serving_quantity_unit,nutrition_data_per,image_front_small_url,image_front_thumb_url,nutriments";
  let response;
  try {
    response = $http.send({
      url: "https://world.openfoodfacts.org/api/v3/product/" + encodeURIComponent(barcode) + "?fields=" + encodeURIComponent(fields),
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": userAgent() },
      timeout: 10,
    });
  } catch (_) {
    throw providerError("temporarily_unavailable", "Open Food Facts is temporarily unavailable.", true);
  }
  if (response.statusCode === 404) return null;
  if (response.statusCode === 429) throw providerError("rate_limited", "Open Food Facts is limiting barcode lookups. Try again in a minute.", false);
  if (response.statusCode === 408 || response.statusCode >= 500) throw providerError("temporarily_unavailable", "Open Food Facts is temporarily unavailable.", true);
  if (response.statusCode < 200 || response.statusCode >= 300) throw providerError("temporarily_unavailable", "Open Food Facts could not complete this barcode lookup.", false);
  return offProduct((response.json || {}).product || {});
}

/* ----------------------------- described portions ----------------------------- */

// A portion described in words, estimated by a language model from its own knowledge. There is
// deliberately no search or grounding: the owner wants a quick approximation of what they just
// ate, and a wrong-but-plausible number they can correct beats a slow lookup that finds nothing.
const ESTIMATE_MODEL = "gemini-3.1-flash-lite";
const ESTIMATE_MAX_GRAMS = 1000;
const ESTIMATE_NAME_LIMIT = 120;

const ESTIMATE_INSTRUCTIONS = [
  "You estimate the nutrition of food a person has just eaten, using your own knowledge. Answer from what you know; never ask a question and never reply with anything but the requested JSON.",
  "",
  "The request may be a description, a photograph, or both. It may be a single food, a packaged product, a home-cooked or restaurant dish, or several things eaten together. Estimate the totals for the WHOLE portion, never per 100 g. When several things are given, add them together into one entry. When no quantity is stated or visible, assume one typical single serving for an adult.",
  "",
  "With a photograph:",
  "- A picture of food: estimate what is actually on the plate or in the container in front of you, not a standard recipe portion.",
  "- A picture of a nutrition label: read it, and report one portion as eaten. Use the per-pack column when the pack is a single serving, otherwise the stated serving size, and say in portion which column you used and what you scaled from.",
  "- A picture of a recipe, a menu, or an article: use the per-serving figures it states, and say so in portion.",
  "- Name the food from what is in the picture, cleaned up: no brand slogans, no packaging or marketing words.",
  "- When a description comes with the picture, the picture says what the food is and the description says how much of it was eaten.",
  "- When the picture shows no food, no label, and no recipe, set recognised to false rather than guessing.",
  "",
  "Fields:",
  "- recognised: true when the text describes something eaten or drunk. false when it is not food, or is far too vague to estimate at all; then use empty strings, zeros, \"low\", and give the reason in note.",
  "- name: a short name for a food diary, at most 60 characters, in sentence case. Include the quantity only when it is part of what was eaten, such as \"Two slices of pepperoni pizza\". No brand slogans, no packaging words.",
  "- portion: the portion the numbers are for, in words, including any assumption you made, such as \"1 medium bowl, about 250 g\".",
  "- protein, fat, carbs: grams for the whole portion, plain numbers with at most one decimal. Carbohydrate excludes fibre. Do not report energy: it is calculated from these three.",
  "- confidence: \"high\" for a plain single food or a labelled product, \"medium\" for a common dish, \"low\" for a vague, unusual, or highly variable description.",
  "- note: at most one short sentence, and only when something genuinely needs flagging, such as a wide plausible range or a guessed cooking method. Otherwise an empty string. Alcohol is not one of the three macronutrients, so for an alcoholic drink say in the note roughly how much energy the alcohol itself adds.",
].join("\n");

const ESTIMATE_SCHEMA = {
  type: "OBJECT",
  properties: {
    recognised: { type: "BOOLEAN" },
    name: { type: "STRING" },
    portion: { type: "STRING" },
    protein: { type: "NUMBER" },
    fat: { type: "NUMBER" },
    carbs: { type: "NUMBER" },
    confidence: { type: "STRING", enum: ["high", "medium", "low"] },
    note: { type: "STRING" },
  },
  required: ["recognised", "name", "portion", "protein", "fat", "carbs", "confidence", "note"],
  propertyOrdering: ["recognised", "name", "portion", "protein", "fat", "carbs", "confidence", "note"],
};

// The same shape in ordinary JSON Schema, which is what an OpenAI-compatible endpoint expects for
// strict structured output. Two spellings of one contract; keep them in step.
const ESTIMATE_JSON_SCHEMA = {
  type: "object",
  properties: {
    recognised: { type: "boolean" },
    name: { type: "string" },
    portion: { type: "string" },
    protein: { type: "number" },
    fat: { type: "number" },
    carbs: { type: "number" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    note: { type: "string" },
  },
  required: ["recognised", "name", "portion", "protein", "fat", "carbs", "confidence", "note"],
  additionalProperties: false,
};

const ESTIMATE_IMAGE_TYPES = ["image/jpeg", "image/webp", "image/png"];
// A 1280px JPEG is a couple of hundred kilobytes; this leaves room for a generous one and still
// refuses anything that would tie the model up or fill a request log.
const ESTIMATE_IMAGE_MAX_BASE64 = 6 * 1024 * 1024;

function validateEstimateImage(raw) {
  if (raw === null || raw === undefined) return null;
  const image = raw || {};
  const mimeType = trimmed(image.mimeType).toLowerCase();
  const data = trimmed(image.data);
  if (ESTIMATE_IMAGE_TYPES.indexOf(mimeType) < 0) throw failure(400, "invalid_image", "Send a JPEG, PNG, or WebP photo.");
  if (!data) throw failure(400, "invalid_image", "The photo is empty.");
  if (data.length > ESTIMATE_IMAGE_MAX_BASE64) throw failure(400, "invalid_image", "The photo is too large to estimate.");
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(data)) throw failure(400, "invalid_image", "The photo could not be read.");
  return { mimeType: mimeType, data: data.replace(/[\r\n]/g, "") };
}

function estimateGrams(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw providerError("invalid_estimate", "The food estimator returned an unusable " + label + " value.", false);
  return Math.round(Math.min(number, ESTIMATE_MAX_GRAMS) * 10) / 10;
}

function normalizeEstimate(payload) {
  const value = payload || {};
  const note = trimmed(value.note).slice(0, 300);
  if (value.recognised === false) {
    return { recognised: false, name: "", portion: "", protein: 0, fat: 0, carbs: 0, confidence: "low", note: note || null };
  }
  const name = trimmed(value.name).slice(0, ESTIMATE_NAME_LIMIT);
  if (!name) throw providerError("invalid_estimate", "The food estimator returned no food name.", false);
  const confidence = ["high", "medium", "low"].indexOf(trimmed(value.confidence)) >= 0 ? trimmed(value.confidence) : "low";
  return {
    recognised: true,
    name: name,
    portion: trimmed(value.portion).slice(0, 200),
    protein: estimateGrams(value.protein, "protein"),
    fat: estimateGrams(value.fat, "fat"),
    carbs: estimateGrams(value.carbs, "carbohydrate"),
    confidence: confidence,
    note: note || null,
  };
}

/**
 * Which model answers, and how to reach it.
 *
 * Two shapes cover essentially every provider worth pointing this at: Gemini's own API, and the
 * OpenAI chat-completions shape that OpenAI, OpenRouter, Groq, and a local Ollama or llama.cpp all
 * speak. `GEMINI_API_KEY` and `GEMINI_MODEL` are still read, so a server configured before the
 * setting was generalised keeps working untouched.
 */
function estimatorSettings() {
  const key = trimmed($os.getenv("AI_API_KEY")) || trimmed($os.getenv("GEMINI_API_KEY"));
  if (!key) return null;
  const declared = trimmed($os.getenv("AI_PROVIDER")).toLowerCase();
  const provider = declared === "openai" ? "openai" : "gemini";
  const model = trimmed($os.getenv("AI_MODEL")) || trimmed($os.getenv("GEMINI_MODEL"))
    || (provider === "gemini" ? ESTIMATE_MODEL : "");
  const baseUrl = (trimmed($os.getenv("AI_BASE_URL")) || "https://api.openai.com/v1").replace(/\/+$/, "");
  return { provider: provider, key: key, model: model, baseUrl: baseUrl };
}

// Every provider failure the owner can act on, named the same way whichever endpoint produced it.
// The key is never quoted back in any of these messages.
function estimatorHttpError(statusCode) {
  if (statusCode === 401 || statusCode === 403) return providerError("estimator_unavailable", "This server's food estimator key was rejected.", false);
  if (statusCode === 429) return providerError("rate_limited", "The food estimator is rate limited right now. Try again in a minute.", false);
  if (statusCode === 408 || statusCode >= 500) return providerError("temporarily_unavailable", "The food estimator is temporarily unavailable.", true);
  if (statusCode < 200 || statusCode >= 300) return providerError("temporarily_unavailable", "The food estimator could not answer that description.", false);
  return null;
}

function estimatorSend(request) {
  try {
    return $http.send(request);
  } catch (_) {
    throw providerError("temporarily_unavailable", "The food estimator is temporarily unreachable.", true);
  }
}

function parseEstimateAnswer(text) {
  const answer = String(text || "").trim();
  if (!answer) throw providerError("invalid_estimate", "The food estimator returned an empty answer.", false);
  try {
    return JSON.parse(answer);
  } catch (_) {
    throw providerError("invalid_estimate", "The food estimator returned an unreadable answer.", false);
  }
}

// Comfortably inside the client's own budget for this request, so a stalled model shows as an
// explained failure in the picker rather than an aborted request. A photograph takes materially
// longer to read than a sentence.
function estimateTimeout(image) {
  return image ? 40 : 20;
}

function requestGemini(settings, description, image) {
  const parts = [];
  // The picture goes first: the model reads it as the subject, and the words that follow as what
  // to do about it.
  if (image) parts.push({ inline_data: { mime_type: image.mimeType, data: image.data } });
  parts.push({ text: description || "Estimate the food in this picture." });
  const response = estimatorSend({
    url: "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(settings.model) + ":generateContent",
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": settings.key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: ESTIMATE_INSTRUCTIONS }] },
      contents: [{ role: "user", parts: parts }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
        responseSchema: ESTIMATE_SCHEMA,
      },
    }),
    timeout: estimateTimeout(image),
  });
  const httpError = estimatorHttpError(response.statusCode);
  if (httpError) throw httpError;
  const candidate = ((response.json || {}).candidates || [])[0] || {};
  const answer = (candidate.content || {}).parts || [];
  return parseEstimateAnswer(answer.map((part) => String(part.text || "")).join(""));
}

function requestOpenAICompatible(settings, description, image) {
  const content = [];
  if (image) content.push({ type: "image_url", image_url: { url: "data:" + image.mimeType + ";base64," + image.data } });
  content.push({ type: "text", text: description || "Estimate the food in this picture." });
  const response = estimatorSend({
    url: settings.baseUrl + "/chat/completions",
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + settings.key },
    body: JSON.stringify({
      model: settings.model,
      temperature: 0.2,
      messages: [
        { role: "system", content: ESTIMATE_INSTRUCTIONS },
        { role: "user", content: content },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "food_estimate", strict: true, schema: ESTIMATE_JSON_SCHEMA },
      },
    }),
    timeout: estimateTimeout(image),
  });
  const httpError = estimatorHttpError(response.statusCode);
  if (httpError) throw httpError;
  const choice = ((response.json || {}).choices || [])[0] || {};
  return parseEstimateAnswer((choice.message || {}).content);
}

function requestEstimate(settings, description, image) {
  return settings.provider === "openai"
    ? requestOpenAICompatible(settings, description, image)
    : requestGemini(settings, description, image);
}

/**
 * One estimate, with a couple of retries.
 *
 * A missing key is reported as its own condition rather than as a failure of the model: the
 * owner has to change the server, not try again. Rate limiting is never retried here, because
 * an immediate second call cannot succeed and would only spend the quota faster.
 */
function estimatePortion(description, image) {
  const settings = estimatorSettings();
  if (!settings) throw providerError("estimator_unavailable", "This server has no food estimator configured.", false);
  if (!settings.model) throw providerError("estimator_unavailable", "This server's food estimator has no model configured. Set AI_MODEL.", false);
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return normalizeEstimate(requestEstimate(settings, description, image));
    } catch (error) {
      lastError = error;
      const retryable = Boolean(error.providerRetryable) || error.providerCode === "invalid_estimate";
      if (!retryable) throw error;
    }
  }
  throw lastError;
}

// The counts are diagnostics: both files are read from disk at runtime, and a deployment that
// shipped without one of them otherwise looks healthy right up until a search returns nothing.
// The published macOS application. The archive itself is served by a plain static route outside
// this dispatcher (see main.pb.js); this only reports what is on offer, so the desktop application
// can tell whether the server has something newer than what is running.
//
// Unauthenticated on purpose: the archive contains no data, and an ordinary download link in a
// browser cannot carry a bearer token.
const MAC_RELEASE_DOWNLOAD_PATH = "/api/calorie-logger/downloads/";

function macRelease() {
  const directory = trimmed($os.getenv("CALORIE_LOGGER_DOWNLOADS_PATH")) || "/pb/downloads";
  let manifest;
  try {
    manifest = JSON.parse(toString($os.readFile(directory + "/release.json")));
  } catch (_) {
    // No macOS application has been published to this server. That is an ordinary state -- a
    // deployment made from Linux cannot build one -- and not a failure to report.
    return null;
  }
  const file = trimmed(manifest.file);
  const version = trimmed(manifest.version);
  const build = trimmed(manifest.build);
  if (!file || !version || !build) return null;
  return {
    version: version,
    build: build,
    file: file,
    size: Number(manifest.size) || 0,
    sha256: trimmed(manifest.sha256),
    url: MAC_RELEASE_DOWNLOAD_PATH + encodeURIComponent(file),
  };
}

route("GET", "/mac-release", false, (e) => respond(e, macRelease()));

function healthEstimator() {
  const settings = estimatorSettings();
  if (!settings) return null;
  return { provider: settings.provider, model: settings.model || null };
}

route("GET", "/health", false, (e) => {
  let cofidCount = 0;
  let pictureCount = 0;
  try { cofidCount = cofidFoods().length; } catch (_) { cofidCount = -1; }
  try { pictureCount = approvedPictures().count; } catch (_) { pictureCount = -1; }
  return respond(e, {
    service: "calorie-logger",
    status: "ok",
    version: appVersion(),
    build: appBuild(),
    apiVersion: API_VERSION,
    schemaVersion: SCHEMA_VERSION,
    cofidFoods: cofidCount,
    foodPictures: pictureCount,
    // Which provider and model will answer, never the key. A deployment that forgot the estimator
    // secret otherwise looks healthy right up until the first description is estimated.
    foodEstimator: healthEstimator(),
    macRelease: macRelease(),
  });
});

route("POST", "/session", false, (e) => {
  const request = body(e);
  let user;
  try { user = e.app.findAuthRecordByEmail("users", trimmed(request.email)); }
  catch (_) { throw failure(401, "invalid_credentials", "The email or password is incorrect."); }
  if (!user.validatePassword(String(request.password || ""))) throw failure(401, "invalid_credentials", "The email or password is incorrect.");
  return respond(e, { token: user.newAuthToken(), user: { id: user.id, email: user.email() } });
});

route("POST", "/session/refresh", true, (e) => respond(e, { token: e.auth.newAuthToken(), user: { id: e.auth.id, email: e.auth.email() } }));

// The only data route. A client pushes the records it has changed since it last succeeded and
// receives everything it has not seen, so a device that has been offline for a week and a device
// that has been offline for a minute follow exactly the same path.
route("POST", "/sync", true, (e) => {
  const request = body(e);
  if (request.schemaVersion !== SCHEMA_VERSION) {
    throw failure(409, "schema_version_mismatch", "This copy of Calorie Logger is out of date and cannot sync. Update the app to continue.", { schemaVersion: SCHEMA_VERSION });
  }
  const owner = ownerID(e);
  const device = validDeviceID(request.deviceId);
  const since = Math.round(finiteNumber(request.since === undefined ? 0 : request.since, "Sync cursor", false));
  const changes = request.changes || {};
  let result;
  e.app.runInTransaction((tx) => {
    const sequence = sequenceRecord(tx, owner);
    const context = { app: tx, owner: owner, device: device, sequence: sequence.getInt("sequence") };
    const rejected = [];
    const winners = [];
    mergeAll(context, changes, rejected, winners);
    if (context.sequence !== sequence.getInt("sequence")) {
      sequence.set("sequence", context.sequence);
      tx.save(sequence);
    }
    result = {
      schemaVersion: SCHEMA_VERSION,
      serverTime: new Date().toISOString(),
      // Identifies the database this owner's revision numbers belong to. Every deployment during
      // development rebuilds the database, which restarts the sequence at zero; a device holding
      // a cursor from the previous database would otherwise pull nothing until the new sequence
      // climbed past it, and quietly show stale data while reporting itself in sync.
      datasetId: sequence.id,
      cursor: context.sequence,
      changes: pullChanges(context, since, winners),
      rejected: rejected,
    };
  });
  return respond(e, result);
});

route("GET", "/external-foods", true, (e) => {
  const search = trimmed(query(e, "query"));
  if (search.length < 2 || search.length > 120) throw failure(400, "invalid_query", "Enter between 2 and 120 characters to search foods.");
  const attempt = Number(query(e, "attempt") || "0");
  if (!Number.isInteger(attempt) || attempt < 0 || attempt > 2) throw failure(400, "invalid_attempt", "Choose a valid search attempt.");
  let off = [];
  let offError = null;
  try { off = searchOFF(search, attempt); }
  catch (error) { offError = {
    source: "openFoodFacts",
    code: error.providerCode || "temporarily_unavailable",
    message: String(error.message || "Open Food Facts is unavailable. Showing CoFID results."),
    retryable: Boolean(error.providerRetryable),
  }; }
  let cofid = [];
  let cofidError = null;
  try { cofid = searchCoFID(search); }
  catch (_) { cofidError = { source: "cofid", code: "temporarily_unavailable", message: "The CoFID catalogue is unavailable.", retryable: false }; }
  return respond(e, { results: off.concat(cofid), errors: [offError, cofidError].filter(Boolean) });
});

// A portion described in words, photographed, or both. It answers with numbers to review, never
// with a logged entry: an estimate the owner has not seen is not something to put in their day.
route("POST", "/food-estimate", true, (e) => {
  const request = body(e);
  const description = trimmed(request.description);
  const image = validateEstimateImage(request.image);
  if (description && (description.length < 2 || description.length > 400)) {
    throw failure(400, "invalid_description", "Describe what you ate in 2 to 400 characters.");
  }
  if (!description && !image) {
    throw failure(400, "invalid_description", "Describe what you ate, or send a photo of it.");
  }
  try {
    return respond(e, estimatePortion(description, image));
  } catch (error) {
    const code = error.providerCode || "temporarily_unavailable";
    const status = code === "rate_limited" ? 429 : 424;
    throw failure(status, code, String(error.message || "The food estimator could not answer that description."));
  }
});

route("GET", "/external-foods/barcode", true, (e) => {
  const barcode = validBarcode(query(e, "code"));
  try {
    return respond(e, lookupOFF(barcode));
  } catch (error) {
    const code = error.providerCode || "temporarily_unavailable";
    const status = code === "rate_limited" ? 429 : 424;
    throw failure(status, code, String(error.message || "Open Food Facts could not complete this barcode lookup."));
  }
});

module.exports = { dispatch: dispatch, mapOpenFoodFactsProduct: offProduct, validateBarcode: validBarcode };
