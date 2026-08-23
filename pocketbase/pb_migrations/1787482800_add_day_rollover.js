migrate((app) => {
  const collection = app.findCollectionByNameOrId("user_settings");
  // Minutes after local midnight a new day begins, so meals logged after midnight but before
  // this time still count towards the previous day. 0 (plain midnight) is the default and
  // matches every existing record once this field is added.
  collection.fields.add(new Field({
    type: "number",
    name: "day_rollover_minutes",
    min: 0,
    max: 1439,
    onlyInt: true,
  }));
  app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("user_settings");
  collection.fields.removeByName("day_rollover_minutes");
  app.save(collection);
});
