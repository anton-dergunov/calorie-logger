migrate((app) => {
  // PocketBase bootstraps its own `users` auth collection into a fresh data directory, so this
  // takes ownership of whichever one exists rather than colliding with it. Either way the rules
  // end up closed: accounts are created by an administrator, never by self-registration.
  let users;
  try {
    users = app.findCollectionByNameOrId("users");
  } catch (_) {
    users = new Collection({ type: "auth", name: "users" });
  }
  users.listRule = null;
  users.viewRule = null;
  users.createRule = null;
  users.updateRule = null;
  users.deleteRule = null;
  users.manageRule = null;
  users.passwordAuth = { enabled: true };
  app.save(users);

  const lockedRules = {
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
  };

  // Fields shared by every replicated collection.
  //
  // `edited_at`/`edited_by` carry the writing device's clock and identity and decide which
  // version of a record wins a merge. `revision` is assigned by the server from the owner's
  // `sync_state.sequence` and is the cursor clients pull against: a wall clock cannot serve
  // that purpose because records written while a request is in flight would be skipped.
  // `deleted` marks a tombstone; replicated rows are never removed, so a client that has been
  // offline still learns about deletions.
  const syncFields = [
    { type: "bool", name: "deleted" },
    { type: "text", name: "created_at", required: true, max: 40 },
    { type: "text", name: "edited_at", required: true, max: 40 },
    { type: "text", name: "edited_by", required: true, max: 32 },
    { type: "number", name: "revision", min: 0, onlyInt: true },
  ];

  const foods = new Collection({
    type: "base",
    name: "foods",
    ...lockedRules,
    fields: [
      { type: "relation", name: "owner", required: true, maxSelect: 1, collectionId: users.id, cascadeDelete: true },
      { type: "text", name: "name", required: true, max: 120 },
      { type: "text", name: "icon", required: true, max: 64 },
      { type: "number", name: "basis_amount", required: true, min: 0 },
      { type: "select", name: "unit", required: true, maxSelect: 1, values: ["g", "ml", "item"] },
      { type: "select", name: "source_provider", maxSelect: 1, values: ["openFoodFacts", "cofid"] },
      { type: "text", name: "source_id", max: 120 },
      // Eaten once and kept out of the catalogue. Stored like any other food so entries can
      // reference it, and hidden only where foods are offered for choosing.
      { type: "bool", name: "one_off" },
      { type: "number", name: "calories", min: 0 },
      { type: "number", name: "protein", min: 0 },
      { type: "number", name: "fat", min: 0 },
      { type: "number", name: "carbs", min: 0 },
      ...syncFields,
    ],
    // There is deliberately no unique index on (owner, source_provider, source_id). A unique
    // constraint cannot survive replication: two devices that scan the same barcode while both
    // are offline would produce a push that can never merge. Reuse of an already-saved external
    // food is a client-side lookup instead, and the rare duplicate is a catalogue entry the
    // owner can delete.
    indexes: [
      "CREATE INDEX idx_foods_owner_revision ON foods (owner, revision)",
      "CREATE INDEX idx_foods_owner_name ON foods (owner, name COLLATE NOCASE)",
    ],
  });
  app.save(foods);

  const entries = new Collection({
    type: "base",
    name: "log_entries",
    ...lockedRules,
    fields: [
      { type: "relation", name: "owner", required: true, maxSelect: 1, collectionId: users.id, cascadeDelete: true },
      { type: "relation", name: "food", required: true, maxSelect: 1, collectionId: foods.id, cascadeDelete: true },
      { type: "text", name: "log_date", required: true, min: 10, max: 10, pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
      { type: "select", name: "meal", required: true, maxSelect: 1, values: ["breakfast", "lunch", "dinner", "snack"] },
      { type: "number", name: "sort_index", min: 0, onlyInt: true },
      { type: "number", name: "amount", required: true, min: 0 },
      ...syncFields,
    ],
    indexes: [
      "CREATE INDEX idx_entries_owner_revision ON log_entries (owner, revision)",
      "CREATE INDEX idx_entries_owner_day_order ON log_entries (owner, log_date, sort_index)",
      "CREATE INDEX idx_entries_owner_food ON log_entries (owner, food)",
    ],
  });
  app.save(entries);

  const settings = new Collection({
    type: "base",
    name: "user_settings",
    ...lockedRules,
    fields: [
      { type: "relation", name: "owner", required: true, maxSelect: 1, collectionId: users.id, cascadeDelete: true },
      { type: "bool", name: "has_calories" },
      { type: "number", name: "calories", min: 0 },
      { type: "bool", name: "has_protein" },
      { type: "number", name: "protein", min: 0 },
      { type: "bool", name: "has_fat" },
      { type: "number", name: "fat", min: 0 },
      { type: "bool", name: "has_carbs" },
      { type: "number", name: "carbs", min: 0 },
      ...syncFields,
    ],
    indexes: ["CREATE UNIQUE INDEX idx_user_settings_owner ON user_settings (owner)"],
  });
  app.save(settings);

  // Server-owned merge bookkeeping. It is deliberately not part of `user_settings`: that record
  // is replicated to clients and last-writer-wins, and a counter the server alone may advance
  // must not be something a stale device can overwrite.
  const syncState = new Collection({
    type: "base",
    name: "sync_state",
    ...lockedRules,
    fields: [
      { type: "relation", name: "owner", required: true, maxSelect: 1, collectionId: users.id, cascadeDelete: true },
      { type: "number", name: "sequence", min: 0, onlyInt: true },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_sync_state_owner ON sync_state (owner)"],
  });
  app.save(syncState);
});
