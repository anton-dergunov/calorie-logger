#!/usr/bin/env python3
"""Run the Calorie Logger API integration suite against a disposable PocketBase process."""

from __future__ import annotations

import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from urllib.parse import quote

import yaml
from pathlib import Path


REPOSITORY = Path(__file__).resolve().parents[2]
API = "/api/calorie-logger/v5"
SCHEMA_VERSION = 2
ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"


def record_id() -> str:
    """A client-generated id in PocketBase's own format."""
    return "".join(secrets.choice(ALPHABET) for _ in range(15))


def instant(seconds: int) -> str:
    """A deterministic writer timestamp in the exact shape the server insists on."""
    return f"2026-08-20T09:{seconds // 60:02d}:{seconds % 60:02d}.000Z"


def food(identifier: str, name: str, edited: str, deleted: bool = False, **overrides):
    payload = {
        "id": identifier, "name": name, "icon": "pic:cereal", "basisAmount": 100, "unit": "g",
        "source": None, "oneOff": False, "calories": 370, "protein": 13, "fat": 7, "carbs": 62,
        "deleted": deleted, "createdAt": instant(0), "editedAt": edited,
    }
    payload.update(overrides)
    return payload


def entry(identifier: str, food_id: str, date: str, edited: str, deleted: bool = False, **overrides):
    payload = {
        "id": identifier, "foodId": food_id, "date": date, "meal": "breakfast", "sortIndex": 0,
        "amount": 250, "deleted": deleted, "createdAt": instant(0), "editedAt": edited,
    }
    payload.update(overrides)
    return payload


def sync(base, token, device, since=0, foods=None, entries=None, settings=None, expected=200, schema_version=SCHEMA_VERSION):
    return calorie_logger(base, token, "POST", "/sync", {
        "schemaVersion": schema_version,
        "deviceId": device,
        "since": since,
        "changes": {"foods": foods or [], "entries": entries or [], "settings": settings},
    }, expected)


def by_id(records):
    return {record["id"]: record for record in records}


def request(base: str, method: str, path: str, body=None, token: str | None = None):
    headers = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = token
    data = None if body is None else json.dumps(body).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(base + path, data=data, headers=headers, method=method), timeout=15) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        payload = json.loads(error.read() or b"{}")
        return error.code, payload


def calorie_logger(base: str, token: str, method: str, path: str, body=None, expected: int = 200):
    status, envelope = request(base, method, API + path, body, "Bearer " + token)
    assert status == expected, (method, path, status, envelope)
    if expected >= 400:
        assert set(envelope) == {"error"}
        assert envelope["error"]["code"]
        return envelope["error"]
    assert set(envelope) == {"data"}
    return envelope["data"]


def free_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def main() -> int:
    binary_value = os.environ.get("POCKETBASE_BIN")
    if not binary_value:
        raise SystemExit("Set POCKETBASE_BIN to a PocketBase 0.39.10 executable.")
    binary = Path(binary_value).resolve()
    if not binary.is_file():
        raise SystemExit(f"PocketBase executable does not exist: {binary}")

    with tempfile.TemporaryDirectory(prefix="calorie-logger-pocketbase-integration-") as directory_value:
        directory = Path(directory_value)
        local_binary = directory / "pocketbase"
        shutil.copy2(binary, local_binary)
        shutil.copytree(REPOSITORY / "pocketbase/pb_hooks", directory / "pb_hooks")
        shutil.copytree(REPOSITORY / "pocketbase/pb_migrations", directory / "pb_migrations")
        if (REPOSITORY / "web/dist").is_dir():
            shutil.copytree(REPOSITORY / "web/dist", directory / "pb_public")

        suffix = secrets.token_hex(8)
        admin_email = f"admin-{suffix}@example.invalid"
        admin_password = secrets.token_urlsafe(24)
        user_password = secrets.token_urlsafe(24)
        data = directory / "pb_data"
        subprocess.run(
            [str(local_binary), "superuser", "create", admin_email, admin_password, "--dir", str(data)],
            cwd=directory,
            check=True,
            stdout=subprocess.DEVNULL,
        )

        port = free_port()
        base = f"http://127.0.0.1:{port}"
        environment = os.environ.copy()
        # Deliberately no path overrides: the hook reads the CoFID catalogue and the approved
        # picture list the same way a deployment does, relative to the working directory. An
        # override here would hide a release that shipped without one of those files.
        environment["CALORIE_LOGGER_DISABLE_OPEN_FOOD_FACTS"] = "1"
        # The estimator is a paid external model, so the suite runs without a key and asserts
        # the unconfigured behaviour instead of spending calls on every test run.
        for name in ("AI_API_KEY", "AI_PROVIDER", "AI_MODEL", "AI_BASE_URL", "GEMINI_API_KEY", "GEMINI_MODEL"):
            environment.pop(name, None)
        server = subprocess.Popen(
            [str(local_binary), "serve", "--http", f"127.0.0.1:{port}", "--dir", str(data)],
            cwd=directory,
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            for _ in range(100):
                try:
                    status, health = request(base, "GET", API + "/health")
                    if status == 200:
                        break
                except OSError:
                    time.sleep(0.05)
            else:
                raise AssertionError("PocketBase did not become ready.")
            # The counts prove the server can actually read the two files it serves food from.
            assert health["data"]["service"] == "calorie-logger"
            assert health["data"]["status"] == "ok"
            assert health["data"]["apiVersion"] == 5
            assert health["data"]["schemaVersion"] == SCHEMA_VERSION
            assert health["data"]["cofidFoods"] > 2000, health["data"]
            assert health["data"]["foodPictures"] > 90, health["data"]

            status, admin_auth = request(base, "POST", "/api/collections/_superusers/auth-with-password", {
                "identity": admin_email, "password": admin_password
            })
            assert status == 200, admin_auth
            admin_token = admin_auth["token"]
            sync(base, admin_token, "admindevice0001", expected=401)

            user_tokens = []
            user_emails = []
            for index in range(2):
                email = f"user-{index}-{suffix}@example.invalid"
                status, created = request(base, "POST", "/api/collections/users/records", {
                    "email": email,
                    "password": user_password,
                    "passwordConfirm": user_password,
                    "verified": True,
                }, admin_token)
                assert status == 200, created
                status, login = request(base, "POST", API + "/session", {
                    "email": email, "password": user_password
                })
                assert status == 200, login
                user_tokens.append(login["data"]["token"])
                user_emails.append(email)

            first, second = user_tokens
            phone, tablet, other = "phonedevice0001", "tabletdevice001", "otherowner00001"

            # Self-registration and the generic record API stay closed.
            status, _ = request(base, "POST", "/api/collections/users/records", {
                "email": f"blocked-{suffix}@example.invalid", "password": user_password, "passwordConfirm": user_password
            })
            assert status in (400, 403)
            status, _ = request(base, "GET", "/api/collections/foods/records", token="Bearer " + first)
            assert status in (403, 404)
            sync(base, "invalid-token", phone, expected=401)

            # A new device pulls an empty account and learns the cursor to resume from.
            initial = sync(base, first, phone)
            assert initial["changes"] == {"foods": [], "entries": [], "settings": None}
            assert initial["cursor"] == 0 and initial["rejected"] == []
            assert initial["schemaVersion"] == SCHEMA_VERSION

            # A push is stored under the client's own ids and comes back with server revisions.
            oats_id, entry_id = record_id(), record_id()
            pushed = sync(base, first, phone, foods=[food(oats_id, "Oats", instant(10))],
                          entries=[entry(entry_id, oats_id, "2026-08-20", instant(11))],
                          settings={"targets": {"calories": 2000, "protein": 125, "fat": None, "carbs": 250},
                                    "createdAt": instant(0), "editedAt": instant(12)})
            assert pushed["rejected"] == []
            assert by_id(pushed["changes"]["foods"])[oats_id]["name"] == "Oats"
            assert by_id(pushed["changes"]["foods"])[oats_id]["oneOff"] is False
            assert by_id(pushed["changes"]["entries"])[entry_id]["amount"] == 250
            assert pushed["changes"]["settings"]["targets"] == {"calories": 2000, "protein": 125, "fat": None, "carbs": 250}
            assert pushed["cursor"] == 3
            cursor = pushed["cursor"]

            # A one-off is an ordinary replicated food: it merges and comes back like any other,
            # and the flag survives the round trip so every device hides it from the same list.
            leftovers_id = record_id()
            one_off = sync(base, first, phone, since=cursor,
                           foods=[food(leftovers_id, "Leftover curry", instant(13), oneOff=True, unit="item", basisAmount=1)])
            assert one_off["rejected"] == []
            assert by_id(one_off["changes"]["foods"])[leftovers_id]["oneOff"] is True
            cursor = one_off["cursor"]

            # Every record is owner-scoped: another account sees none of it and cannot address it.
            assert sync(base, second, other)["changes"] == {"foods": [], "entries": [], "settings": None}
            hijack = sync(base, second, other, foods=[food(oats_id, "Not yours", instant(99))])
            assert hijack["rejected"][0]["reason"] == "invalid"
            assert by_id(sync(base, first, phone, since=0)["changes"]["foods"])[oats_id]["name"] == "Oats"

            # A second device of the same owner pulls everything from scratch.
            tablet_view = sync(base, first, tablet, since=0)
            assert by_id(tablet_view["changes"]["foods"])[oats_id]["name"] == "Oats"
            assert len(tablet_view["changes"]["entries"]) == 1

            # The cursor only returns what a device has not seen.
            assert sync(base, first, phone, since=cursor)["changes"] == {"foods": [], "entries": [], "settings": None}

            # Two devices edit one record while both are offline: the later write survives.
            sync(base, first, tablet, since=cursor, foods=[food(oats_id, "Tablet oats", instant(30))])
            losing = sync(base, first, phone, since=cursor, foods=[food(oats_id, "Phone oats", instant(20))])
            assert losing["rejected"] == [{"collection": "foods", "id": oats_id, "reason": "superseded"}]
            # The loser is told what beat it, so it stops trying to push its version.
            assert by_id(losing["changes"]["foods"])[oats_id]["name"] == "Tablet oats"
            cursor = losing["cursor"]

            # An identical timestamp is broken by device id, deterministically, so every replica
            # independently reaches the same answer. "phonedevice0001" sorts below "tabletdevice001".
            tie_loss = sync(base, first, phone, since=cursor, foods=[food(oats_id, "Phone tie", instant(30))])
            assert tie_loss["rejected"] == [{"collection": "foods", "id": oats_id, "reason": "superseded"}]
            assert by_id(tie_loss["changes"]["foods"])[oats_id]["name"] == "Tablet oats"
            cursor = tie_loss["cursor"]
            tie_win = sync(base, first, "zdevice00000001", since=cursor, foods=[food(oats_id, "Later device tie", instant(30))])
            assert tie_win["rejected"] == []
            assert by_id(tie_win["changes"]["foods"])[oats_id]["name"] == "Later device tie"
            cursor = tie_win["cursor"]

            # Re-pushing an unchanged record is a no-op rather than a spurious conflict.
            repeat = sync(base, first, "zdevice00000001", since=cursor, foods=[food(oats_id, "Later device tie", instant(30))])
            assert repeat["rejected"] == [] and repeat["cursor"] == cursor

            # A rejected record must not stop the rest of the batch being stored.
            bad_id, good_id = record_id(), record_id()
            mixed = sync(base, first, phone, since=cursor, foods=[
                food(bad_id, "Rejected picture", instant(40), icon="pic:bacon"),
                food(good_id, "Apple slices", instant(41)),
            ])
            assert [item["id"] for item in mixed["rejected"]] == [bad_id]
            assert mixed["rejected"][0]["reason"] == "invalid"
            assert good_id in by_id(mixed["changes"]["foods"])
            for invalid in (
                food(record_id(), "", instant(42)),
                food(record_id(), "Invalid item basis", instant(43), unit="item", basisAmount=2),
                food(record_id(), "Bad timestamp", "2026-08-20T09:00:00Z"),
                food("short-id", "Bad identifier", instant(44)),
            ):
                assert sync(base, first, phone, since=cursor, foods=[invalid])["rejected"][0]["reason"] == "invalid"
            for broken_entry in (
                entry(record_id(), record_id(), "2026-08-20", instant(45)),
                entry(record_id(), good_id, "2026-13-40", instant(46)),
                entry(record_id(), good_id, "2026-08-20", instant(47), meal="brunch"),
                entry(record_id(), good_id, "2026-08-20", instant(48), amount=0),
            ):
                assert sync(base, first, phone, since=cursor, entries=[broken_entry])["rejected"][0]["reason"] == "invalid"
            cursor = sync(base, first, phone, since=cursor)["cursor"]

            # A food and its entry can arrive in one push; the relation must already resolve.
            pear_id, pear_entry_id = record_id(), record_id()
            together = sync(base, first, phone, since=cursor,
                            entries=[entry(pear_entry_id, pear_id, "2026-08-21", instant(50))],
                            foods=[food(pear_id, "Pear", instant(50))])
            assert together["rejected"] == []
            assert pear_entry_id in by_id(together["changes"]["entries"])
            cursor = together["cursor"]

            # Deletions travel as tombstones so a device that was offline still learns about them.
            deleted = sync(base, first, phone, since=cursor,
                           foods=[food(pear_id, "Pear", instant(60), deleted=True)],
                           entries=[entry(pear_entry_id, pear_id, "2026-08-21", instant(60), deleted=True)])
            assert by_id(deleted["changes"]["foods"])[pear_id]["deleted"] is True
            assert by_id(deleted["changes"]["entries"])[pear_entry_id]["deleted"] is True
            catch_up = sync(base, first, tablet, since=0)["changes"]
            assert by_id(catch_up["foods"])[pear_id]["deleted"] is True
            cursor = deleted["cursor"]

            # A tombstoned source can be saved again: nothing unique constrains provenance.
            provenance = {"provider": "cofid", "id": "11-005"}
            imported_id, reimported_id = record_id(), record_id()
            first_import = sync(base, first, phone, since=cursor, foods=[food(imported_id, "Imported oats", instant(70), source=provenance)])
            assert by_id(first_import["changes"]["foods"])[imported_id]["source"]["label"] == "CoFID 2021"
            assert by_id(first_import["changes"]["foods"])[imported_id]["source"]["url"].startswith("https://www.gov.uk/")
            cursor = first_import["cursor"]
            sync(base, first, phone, since=cursor, foods=[food(imported_id, "Imported oats", instant(71), source=provenance, deleted=True)])
            again = sync(base, first, tablet, foods=[food(reimported_id, "Imported oats again", instant(72), source=provenance)])
            assert again["rejected"] == []
            cursor = again["cursor"]

            # The shipped default catalogue is what a new device pushes the first time it syncs.
            # Every food in it has to be acceptable to the server, or seeding wedges the queue.
            catalogue = yaml.safe_load((REPOSITORY / "web/src/data/foods.yaml").read_text(encoding="utf-8"))
            seeded = [
                food(record_id(), item["name"], instant(75), icon=f"pic:{item['picture']}",
                     unit=item["unit"], basisAmount=1 if item["unit"] == "item" else item["basis"],
                     calories=item["calories"], protein=item["protein"], fat=item["fat"], carbs=item["carbs"])
                for item in catalogue
            ]
            seeding = sync(base, first, tablet, since=cursor, foods=seeded)
            assert seeding["rejected"] == [], seeding["rejected"]
            assert len(by_id(seeding["changes"]["foods"])) >= len(seeded)
            cursor = seeding["cursor"]

            # Every reply identifies the database the cursor counts revisions in, and it stays the
            # same for as long as that database does. A device compares it to spot a rebuilt
            # server, whose sequence restarts at zero and would otherwise leave the device pulling
            # nothing while reporting itself in sync.
            identity = sync(base, first, phone, since=cursor)
            assert identity["datasetId"], identity
            assert sync(base, first, tablet, since=0)["datasetId"] == identity["datasetId"]

            # A stale build is refused a merge outright rather than writing the wrong shape.
            mismatch = sync(base, first, phone, since=cursor, schema_version=SCHEMA_VERSION + 1,
                            foods=[food(record_id(), "From the future", instant(80))], expected=409)
            assert mismatch["code"] == "schema_version_mismatch"
            assert mismatch["fields"]["schemaVersion"] == SCHEMA_VERSION
            assert sync(base, first, phone, since=cursor)["changes"]["foods"] == []

            # External catalogue lookups still need the network and are unchanged.
            cofid = calorie_logger(base, first, "GET", "/external-foods?query=creme%20fraiche&attempt=0")
            generic_results = [result for result in cofid["results"] if result["source"]["provider"] == "cofid"]
            assert generic_results
            assert generic_results[0]["nutritionCandidates"][0]["unit"] == "g"

            # Open Food Facts is disabled for this run, which is exactly the case that used to
            # leave the owner with an error and no generic foods at all.
            def generic(query: str):
                response = calorie_logger(base, first, "GET", f"/external-foods?query={quote(query)}&attempt=0")
                assert [error["source"] for error in response["errors"]] == ["openFoodFacts"]
                return [result["name"] for result in response["results"] if result["source"]["provider"] == "cofid"]

            assert generic("tofu")
            # CoFID writes these its own way: "Houmous", "Milk, soya", "Oil, olive". A query that
            # every device owner would type must still find them.
            assert any("Houmous" in name for name in generic("hummus"))
            assert any("soya" in name.lower() for name in generic("soya drink"))
            assert generic("olive oil")[0] == "Oil, olive"
            assert generic("chick peas")
            # Described portions: validated here, answered by the model only when a key is set.
            for description in ("", "a", "x" * 401):
                refusal = calorie_logger(base, first, "POST", "/food-estimate", {"description": description}, expected=400)
                assert refusal["code"] == "invalid_description", refusal
            empty = calorie_logger(base, first, "POST", "/food-estimate", {}, expected=400)
            assert empty["code"] == "invalid_description", empty
            for image in ({"mimeType": "image/gif", "data": "QUJD"},
                          {"mimeType": "image/jpeg", "data": ""},
                          {"mimeType": "image/jpeg", "data": "not base64!"},
                          {"mimeType": "image/jpeg", "data": "A" * (6 * 1024 * 1024 + 1)}):
                refusal = calorie_logger(base, first, "POST", "/food-estimate", {"image": image}, expected=400)
                assert refusal["code"] == "invalid_image", refusal
            unavailable = calorie_logger(base, first, "POST", "/food-estimate", {"description": "a bowl of porridge"}, expected=424)
            assert unavailable["code"] == "estimator_unavailable", unavailable
            # A photo alone is a complete request; only the missing key stops it here.
            photo_only = calorie_logger(base, first, "POST", "/food-estimate",
                                        {"image": {"mimeType": "image/jpeg", "data": "QUJD"}}, expected=424)
            assert photo_only["code"] == "estimator_unavailable", photo_only
            assert calorie_logger(base, first, "GET", "/health")["foodEstimator"] is None

            assert calorie_logger(base, first, "GET", "/external-foods/barcode?code=invalid", expected=400)["code"] == "invalid_barcode"
            assert calorie_logger(base, first, "GET", "/external-foods/barcode?code=5012345678900", expected=424)["code"] == "disabled"

            # Routes the client no longer uses must be gone rather than quietly still working.
            for method, gone in (("GET", "/bootstrap?date=2026-08-20"), ("GET", "/revision"),
                                 ("GET", "/days/2026-08-20"), ("GET", "/export?scope=all"),
                                 ("GET", "/capabilities"), ("POST", "/entries"), ("POST", "/foods")):
                calorie_logger(base, first, method, gone, None if method == "GET" else {}, expected=404)

            refreshed = calorie_logger(base, first, "POST", "/session/refresh")
            assert refreshed["token"] and refreshed["user"]["id"]
            status, manifest = request(base, "GET", "/manifest.webmanifest")
            assert status == 200 and manifest["short_name"] == "Calorie Logger", (status, manifest)
            if os.environ.get("CALORIE_LOGGER_BROWSER_SMOKE") == "1":
                smoke_environment = os.environ.copy()
                smoke_environment.update({
                    "CALORIE_LOGGER_SMOKE_URL": base,
                    "CALORIE_LOGGER_SMOKE_EMAIL": user_emails[0],
                    "CALORIE_LOGGER_SMOKE_PASSWORD": user_password,
                })
                subprocess.run(
                    ["node", str(REPOSITORY / "web/e2e/calorie-logger-smoke.mjs")],
                    cwd=REPOSITORY,
                    env=smoke_environment,
                    check=True,
                )
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
            if server.returncode not in (0, -15):
                print(server.stderr.read(), file=sys.stderr)

    print("Calorie Logger API integration suite passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
