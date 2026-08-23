migrate((app) => {
  const collection = app.findCollectionByNameOrId("user_settings");
  // The share of a daily target at which a food is flagged in the log, as a percentage. 0 means the
  // owner turned flagging off, so existing records are backfilled to the default rather than left at
  // the zero a new number field arrives with -- otherwise "never set" and "switched off" would be
  // the same value and one of them would be wrong.
  collection.fields.add(new Field({
    type: "number",
    name: "contribution_threshold",
    min: 0,
    max: 100,
    onlyInt: true,
  }));
  app.save(collection);
  app.db().newQuery("UPDATE user_settings SET contribution_threshold = 20").execute();
}, (app) => {
  const collection = app.findCollectionByNameOrId("user_settings");
  collection.fields.removeByName("contribution_threshold");
  app.save(collection);
});
