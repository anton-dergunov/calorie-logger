import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const {
  CALORIE_LOGGER_SMOKE_URL: baseURL,
  CALORIE_LOGGER_SMOKE_EMAIL: email,
  CALORIE_LOGGER_SMOKE_PASSWORD: password
} = process.env;
if (!baseURL || !email || !password) throw new Error("Calorie Logger smoke-test connection variables are required.");

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CALORIE_LOGGER_CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
});

async function login(page) {
  await page.goto(baseURL);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Breakfast" }).waitFor();
}

async function assertAddFoodLayout(viewport, phone) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await login(page);
  await page.getByRole("button", { name: /Add food/ }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add food" });
  const box = await dialog.boundingBox();
  assert.ok(box);
  if (phone) {
    assert.ok(Math.abs(box.y + box.height - viewport.height) < 2, "phone dialog should meet the bottom safe edge");
    assert.equal(await page.locator(".add-layout").evaluate((element) => getComputedStyle(element).display), "block");
    assert.equal(await page.locator(".quantity-placeholder").evaluate((element) => getComputedStyle(element).display), "none");
    assert.equal(await page.locator(".food-browser").evaluate((element) => getComputedStyle(element).overflowY), "auto");
    // The whole catalogue has to be reachable. A phone shows around a dozen foods at a time, and
    // the shipped catalogue is far longer than that.
    const reach = await page.locator(".food-browser").evaluate((element) => {
      const items = element.querySelectorAll(".food-choice-main strong");
      const last = items[items.length - 1];
      last.scrollIntoView({ block: "end" });
      const box = last.getBoundingClientRect();
      const view = element.getBoundingClientRect();
      return { count: items.length, visible: box.bottom <= view.bottom + 1 && box.top >= view.top - 1, name: last.textContent };
    });
    assert.ok(reach.count > 40, `expected a long catalogue, saw ${reach.count}`);
    assert.ok(reach.visible, `the last catalogue food (${reach.name}) could not be scrolled into view`);
    assert.equal(await page.locator(".food-list").evaluate((element) => element.scrollHeight <= element.clientHeight), true, "the food list must not be a second scroll container");
    assert.equal(await dialog.evaluate((element) => getComputedStyle(element).overflowY), "hidden");
    assert.match(await page.evaluate(() => getComputedStyle(document.body).overscrollBehaviorY), /none|contain/,
      "pull-to-refresh must be off, or a swipe reloads the app and discards the open dialog");
    // A description is typed where a name would be, so the field grows to fit it. It must not
    // become a second scroller, and what the description can turn into has to be reachable
    // without scrolling past the catalogue.
    const description = "a bowl of porridge made with whole milk, a sliced banana and a spoonful of runny honey";
    await page.getByRole("searchbox", { name: "Search foods" }).fill(description);
    const field = await page.getByRole("searchbox", { name: "Search foods" }).evaluate((element) => ({
      lines: element.getBoundingClientRect().height,
      scrolls: element.scrollHeight > element.clientHeight + 1
    }));
    assert.ok(field.lines > 44, `the search field should grow with a description, saw ${field.lines}px`);
    assert.equal(field.scrolls, false, "the search field must not scroll its own content");
    const estimateBox = await page.getByRole("button", { name: /Estimate it with AI/ }).boundingBox();
    assert.ok(estimateBox && estimateBox.y >= 0 && estimateBox.y + estimateBox.height <= viewport.height + 1,
      "the ways to add what was typed must be reachable without scrolling");
    assert.equal(await page.locator(".food-list").evaluate((element) => element.scrollHeight <= element.clientHeight), true, "the food list must not scroll when the field grows");
    await page.getByRole("searchbox", { name: "Search foods" }).fill("");

    await page.getByRole("button", { name: /Create a food by hand/ }).click();
    const editor = page.getByRole("region", { name: "Create a food" });
    await editor.waitFor();
    // The editor filled the screen but could not be scrolled: it was an `overflow: visible` box
    // positioned against `.add-layout` while living inside `.food-browser`, so it added no height
    // to the only scroller and everything past the fold -- the macros, the save button -- was
    // unreachable. It has to own a scroller and keep its primary action on screen.
    const saveBox = await editor.getByRole("button", { name: "Save" }).boundingBox();
    assert.ok(saveBox, "the editor's save button should be laid out");
    assert.ok(saveBox.y >= 0 && saveBox.y + saveBox.height <= viewport.height + 1,
      `the editor's save button must stay on screen, saw y=${saveBox.y} h=${saveBox.height}`);
    const reachable = await editor.locator(".form-body").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return { scrolled: element.scrollTop > 0 || element.scrollHeight <= element.clientHeight + 1 };
    });
    assert.ok(reachable.scrolled, "the editor body must scroll when its fields overflow");
    // A focus ring is drawn outside its field, and this container's own overflow was clipping it.
    await editor.getByLabel("Nutrition basis amount").focus();
    const ring = await editor.getByLabel("Nutrition basis amount").evaluate((field) => {
      const body = field.closest(".form-body");
      const f = field.getBoundingClientRect(), c = body.getBoundingClientRect();
      const style = getComputedStyle(field);
      return { need: parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset), left: f.left - c.left, right: c.right - f.right };
    });
    assert.ok(ring.left >= ring.need - 0.5 && ring.right >= ring.need - 0.5,
      `the focus ring is clipped: ${ring.left.toFixed(1)}px / ${ring.right.toFixed(1)}px against ${ring.need}px needed`);
    // A long step title has to be readable, not trailed off into an ellipsis.
    const title = await page.getByRole("heading", { level: 2 }).evaluate((heading) => ({
      text: heading.innerText,
      clipped: heading.scrollHeight > heading.clientHeight + 1 || heading.scrollWidth > heading.clientWidth + 1
    }));
    assert.ok(!title.clipped, `the dialog title is cut off: "${title.text}"`);
    await page.getByRole("button", { name: "Change food picture" }).click();
    await page.getByRole("dialog", { name: "Choose picture" }).waitFor();
    await page.getByRole("dialog", { name: "Choose picture" }).getByRole("button", { name: "Close picture chooser" }).click();
    await page.getByRole("button", { name: "Change food picture" }).waitFor();
  } else {
    assert.ok(box.y > 0 && box.y + box.height < viewport.height, "tablet dialog should remain centred");
    assert.equal(await page.locator(".add-layout").evaluate((element) => getComputedStyle(element).display), "grid");
    assert.equal((await page.locator(".add-layout").evaluate((element) => getComputedStyle(element).gridTemplateColumns)).split(" ").length, 2);
    await page.locator(".food-choice-main").first().click();
    const amountBox = await page.getByLabel("Amount consumed").boundingBox();
    const mealBox = await dialog.locator(".quantity-panel .meal-field select").boundingBox();
    const entryAction = await page.locator(".quantity-panel .full-button").boundingBox();
    assert.ok(amountBox && mealBox && entryAction);
    assert.ok(Math.abs(amountBox.height - mealBox.height) < 1, "meal and amount controls should have equal height");

    // The amount panel belongs to the picker. Beside the editor it would offer to log a food
    // the person had stopped looking at, so the editor replaces it with the placeholder.
    await page.getByRole("button", { name: /Create a food by hand/ }).click();
    const editor = page.getByRole("region", { name: "Create a food" });
    await editor.waitFor();
    await page.locator(".quantity-placeholder").waitFor();
    assert.equal(await page.getByLabel("Amount consumed").count(), 0, "the amount panel must not stand beside the editor");
    const editorActions = await editor.locator(".form-actions").boundingBox();
    const layout = await page.locator(".add-layout").boundingBox();
    assert.ok(editorActions && layout);
    assert.ok(editorActions.y + editorActions.height <= layout.y + layout.height + 1,
      "the editor's actions must stay inside the dialog");
  }
  await context.close();
}

/**
 * The copy/move dialog draws its own calendar, because the browser's date popup is drawn outside
 * the page at a size no rule can reach. Ours has to fit a phone: no sideways overflow, one
 * scroller, and the button that performs the copy reachable at the end of it.
 */
async function assertTransferDialog(viewport) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await login(page);
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("button", { name: /Select entries/ }).click();
  await page.locator(".check-cell input").first().check();
  await page.getByRole("button", { name: "Copy…" }).click();
  const dialog = page.getByRole("dialog", { name: /^Copy \d+ entr/ });
  await dialog.waitFor();

  const calendar = await dialog.locator(".month-calendar").boundingBox();
  assert.ok(calendar, "the dialog should draw its own calendar");
  assert.ok(calendar.x >= 0 && calendar.x + calendar.width <= viewport.width + 1,
    `the calendar overflows the phone sideways: ${calendar.x} + ${calendar.width}`);
  assert.equal(await dialog.evaluate((element) =>
    [...element.querySelectorAll("*")].filter((node) => node.scrollHeight > node.clientHeight + 1).length), 1,
    "the copy dialog must own exactly one scroller");

  const reach = await dialog.evaluate((element) => {
    const scroller = [...element.querySelectorAll("*")].find((node) => node.scrollHeight > node.clientHeight + 1) ?? element;
    scroller.scrollTop = scroller.scrollHeight;
    return true;
  });
  assert.ok(reach);
  const confirm = await dialog.getByRole("button", { name: /^Copy \d+ entr/ }).boundingBox();
  assert.ok(confirm && confirm.y >= 0 && confirm.y + confirm.height <= viewport.height + 1,
    "the copy button must be reachable at the end of the dialog");
  await context.close();
}

try {
  const firstContext = await browser.newContext({ acceptDownloads: true });
  const secondContext = await browser.newContext();
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();
  await login(first);
  await login(second);

  await first.getByRole("button", { name: /Add food/ }).first().click();
  await first.getByRole("button", { name: /Create a food by hand/ }).click();
  const create = first.getByRole("region", { name: "Create a food" });
  await create.getByLabel("Food name").fill("Browser smoke oats");
  await create.getByLabel("Calories").fill("370");
  await create.getByLabel("Protein").fill("13");
  await create.getByLabel("Fat").fill("7");
  await create.getByLabel("Carbs").fill("62");
  await create.getByRole("button", { name: "Save" }).click();
  const add = first.getByRole("dialog", { name: "Add food" });
  await add.getByRole("button", { name: "Add to day" }).click();
  const firstLog = first.locator(".meal-log");
  const secondLog = second.locator(".meal-log");
  await add.waitFor({ state: "detached" });
  await firstLog.getByRole("button", { name: "Edit Browser smoke oats" }).waitFor();

  await second.evaluate(() => window.dispatchEvent(new Event("focus")));
  await secondLog.getByRole("button", { name: "Edit Browser smoke oats" }).waitFor({ timeout: 30_000 });

  await first.getByRole("button", { name: "Open settings" }).click();
  await first.getByRole("button", { name: /Export data/ }).click();
  const downloadPromise = first.waitForEvent("download");
  await first.getByRole("dialog", { name: "Export data" }).getByRole("button", { name: "Choose location…" }).click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), "calorie-logger-export.json");

  // The point of the whole design: with the server unreachable, the app still opens and still
  // accepts entries, and everything written meanwhile arrives once it is reachable again.
  await first.getByRole("button", { name: /All changes synced/ }).waitFor({ timeout: 20_000 });
  await firstContext.setOffline(true);
  await first.evaluate(() => window.dispatchEvent(new Event("focus")));
  await first.getByRole("button", { name: /Offline/ }).waitFor({ timeout: 10_000 });

  await first.getByRole("button", { name: "Add food to Lunch" }).click();
  const offlineAdd = first.getByRole("dialog", { name: "Add food" });
  await offlineAdd.getByRole("button", { name: /^Browser smoke oats/ }).click();
  await offlineAdd.getByRole("button", { name: "Add to day" }).click();
  await offlineAdd.waitFor({ state: "detached" });
  await firstLog.getByRole("button", { name: "Edit Browser smoke oats" }).nth(1).waitFor();
  await first.getByRole("button", { name: /1 change waiting/ }).waitFor({ timeout: 10_000 });

  // A cold start with no server must show the day rather than the sign-in screen.
  await first.reload();
  await first.getByRole("heading", { name: "Breakfast" }).waitFor({ timeout: 20_000 });
  assert.equal(await first.locator(".meal-log").getByRole("button", { name: "Edit Browser smoke oats" }).count(), 2);
  await first.getByRole("button", { name: /Open sync details/ }).click();
  const panel = first.getByRole("dialog", { name: "Sync" });
  await panel.getByText("Unreachable").waitFor();
  await panel.getByText("1 change").waitFor();

  // Airplane mode with a VPN interface configured does not fail requests, it leaves them
  // outstanding. Opening the app must not depend on one answering.
  await firstContext.route("**/api/calorie-logger/**", () => undefined);
  await first.reload();
  await first.getByRole("heading", { name: "Breakfast" }).waitFor({ timeout: 20_000 });
  assert.equal(await first.locator(".meal-log").getByRole("button", { name: "Edit Browser smoke oats" }).count(), 2);
  await firstContext.unroute("**/api/calorie-logger/**");

  await first.getByRole("button", { name: /Open sync details/ }).click();
  await firstContext.setOffline(false);
  await panel.getByRole("button", { name: "Sync now" }).click();
  await panel.getByText("Connected").waitFor({ timeout: 20_000 });
  await panel.getByText("Nothing").waitFor();
  await first.getByRole("button", { name: "Close" }).click();

  // The other browser converges on the entry that was written while offline.
  await second.evaluate(() => window.dispatchEvent(new Event("focus")));
  await secondLog.getByRole("button", { name: "Edit Browser smoke oats" }).nth(1).waitFor({ timeout: 30_000 });

  await assertAddFoodLayout({ width: 390, height: 844 }, true);
  await assertAddFoodLayout({ width: 412, height: 915 }, true);
  await assertAddFoodLayout({ width: 768, height: 1024 }, false);
  await assertAddFoodLayout({ width: 1024, height: 768 }, false);
  await assertTransferDialog({ width: 390, height: 844 });

  await first.getByRole("button", { name: "Open settings" }).click();
  await first.getByRole("button", { name: /Connection/ }).click();
  await first.getByRole("button", { name: "Sign out of this device" }).click();
  await first.getByRole("heading", { name: "Sign in" }).waitFor();
  assert.equal(await first.getByLabel("Email").inputValue(), email);
  assert.equal(await first.getByLabel("Password").inputValue(), "");

  // The service worker answers navigations so the app opens offline. It must not answer for
  // PocketBase's own dashboard, which is where accounts are created after a deployment resets
  // the database -- serving the app shell there makes the server unadministrable.
  const dashboard = await firstContext.newPage();
  await dashboard.goto(`${baseURL}/_/`);
  assert.notEqual(await dashboard.title(), "Calorie Logger", "the service worker hijacked the PocketBase dashboard");
  assert.equal(await dashboard.evaluate(() => Boolean(navigator.serviceWorker.controller)), true);
  await dashboard.close();

  await firstContext.close();
  await secondContext.close();
  console.log("Calorie Logger browser smoke test passed.");
} finally {
  await browser.close();
}
