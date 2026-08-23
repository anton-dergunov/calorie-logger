#!/usr/bin/env python3
"""Verify that a deployment keeps the owner's data, including across a schema change.

Calorie Logger is in real use, so this is the suite that says a deployment is safe: records,
accounts, and the sync cursor's dataset identity all have to survive both an ordinary restart
and one that applies a new migration. It runs a real PocketBase over a real database, and
applies a migration the way a release would.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[2]
HELPER = REPOSITORY / "scripts/deploy-pocketbase-remote.sh"
API = "/api/calorie-logger/v5"


def helper_preserves_data() -> None:
    """The deployment helper must back the database up and never delete it without being asked."""
    source = HELPER.read_text(encoding="utf-8")
    assert 'backup_root="$install_root/backups"' in source, "the helper no longer backs the database up"
    assert 'if [ "$reset_data" = true ]; then' in source, "the helper no longer gates deletion behind --reset-data"
    unconditional = re.findall(r'^\s*rm -rf "\$data_path"', source, re.M)
    assert len(unconditional) == 1, f"the helper deletes the data directory in {len(unconditional)} places"


def request(base: str, method: str, path: str, body=None, token: str | None = None):
    headers = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = token
    data = None if body is None else json.dumps(body).encode()
    try:
        with urllib.request.urlopen(
            urllib.request.Request(base + path, data=data, headers=headers, method=method), timeout=15
        ) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or b"{}")


def free_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


class Server:
    def __init__(self, directory: Path, binary: Path, data: Path):
        self.directory = directory
        self.binary = binary
        self.data = data
        self.process: subprocess.Popen | None = None
        self.base = ""

    def start(self):
        port = free_port()
        self.base = f"http://127.0.0.1:{port}"
        environment = os.environ.copy()
        environment["CALORIE_LOGGER_COFID_PATH"] = str(self.directory / "pb_hooks/data/cofid-2021.json")
        environment["CALORIE_LOGGER_DISABLE_OPEN_FOOD_FACTS"] = "1"
        self.process = subprocess.Popen(
            [str(self.binary), "serve", "--http", f"127.0.0.1:{port}", "--dir", str(self.data)],
            cwd=self.directory, env=environment,
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
        )
        for _ in range(200):
            try:
                if request(self.base, "GET", API + "/health")[0] == 200:
                    return
            except OSError:
                time.sleep(0.05)
        raise AssertionError("PocketBase did not become ready.")

    def stop(self):
        if not self.process:
            return
        self.process.terminate()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
        self.process = None


def main() -> int:
    binary_value = os.environ.get("POCKETBASE_BIN")
    if not binary_value:
        raise SystemExit("Set POCKETBASE_BIN to a PocketBase 0.39.10 executable.")
    binary = Path(binary_value).resolve()
    if not binary.is_file():
        raise SystemExit(f"PocketBase executable does not exist: {binary}")
    if not shutil.which("sqlite3"):
        raise SystemExit("sqlite3 is required to inspect the migrated database.")
    helper_preserves_data()

    with tempfile.TemporaryDirectory(prefix="calorie-logger-preservation-") as directory_value:
        directory = Path(directory_value)
        local_binary = directory / "pocketbase"
        shutil.copy2(binary, local_binary)
        shutil.copytree(REPOSITORY / "pocketbase/pb_hooks", directory / "pb_hooks")
        shutil.copytree(REPOSITORY / "pocketbase/pb_migrations", directory / "pb_migrations")

        suffix = secrets.token_hex(8)
        admin_email = f"admin-{suffix}@example.invalid"
        admin_password = secrets.token_hex(16)
        user_email = f"user-{suffix}@example.invalid"
        user_password = secrets.token_hex(16)
        data = directory / "pb_data"

        subprocess.run(
            [str(local_binary), "superuser", "create", admin_email, admin_password, "--dir", str(data)],
            cwd=directory, check=True, stdout=subprocess.DEVNULL,
        )

        server = Server(directory, local_binary, data)
        server.start()
        try:
            status, admin_auth = request(server.base, "POST", "/api/collections/_superusers/auth-with-password", {
                "identity": admin_email, "password": admin_password
            })
            assert status == 200, admin_auth
            admin_token = "Bearer " + admin_auth["token"]

            status, created = request(server.base, "POST", "/api/collections/users/records", {
                "email": user_email, "password": user_password,
                "passwordConfirm": user_password, "verified": True,
            }, admin_token)
            assert status == 200, created
            owner_id = created["id"]

            status, login = request(server.base, "POST", API + "/session", {
                "email": user_email, "password": user_password
            })
            assert status == 200, login
            token_before = login["data"]["token"]

            # A day's worth of real records: a food, an entry that references it, and targets.
            status, synced = request(server.base, "POST", API + "/sync", {
                "schemaVersion": 4, "deviceId": "device000000001", "since": 0,
                "changes": {
                    "foods": [{
                        "id": "food00000000001", "name": "Oats", "icon": "pic:cereal", "basisAmount": 100,
                        "unit": "g", "source": None, "oneOff": False, "calories": 370, "protein": 13, "fat": 7, "carbs": 62,
                        "deleted": False, "createdAt": "2026-08-20T09:00:00.000Z",
                        "editedAt": "2026-08-20T09:00:00.000Z",
                    }],
                    "entries": [{
                        "id": "entry0000000001", "foodId": "food00000000001", "date": "2026-08-20",
                        "meal": "breakfast", "sortIndex": 0, "amount": 65, "deleted": False,
                        "createdAt": "2026-08-20T09:00:00.000Z", "editedAt": "2026-08-20T09:00:01.000Z",
                    }],
                    "settings": {
                        "targets": {"calories": 2000, "protein": 125, "fat": None, "carbs": 250},
                        "dayRolloverMinutes": 0, "contributionThreshold": 20,
                        "createdAt": "2026-08-20T09:00:00.000Z", "editedAt": "2026-08-20T09:00:02.000Z",
                    },
                },
            }, "Bearer " + token_before)
            assert status == 200, synced
            assert len(synced["data"]["changes"]["foods"]) == 1
            dataset_id = synced["data"]["datasetId"]
            cursor_before = synced["data"]["cursor"]
            assert dataset_id and cursor_before > 0, synced
        finally:
            server.stop()

        # --- a release that changes the schema: a new migration, applied to the same database ---
        migration = directory / "pb_migrations" / "1900000000_preservation_probe.js"
        migration.write_text(
            "migrate((app) => {\n"
            "  const foods = app.findCollectionByNameOrId('foods');\n"
            "  foods.fields.add(new TextField({ name: 'preservation_probe', max: 40 }));\n"
            "  app.save(foods);\n"
            "}, (app) => {\n"
            "  const foods = app.findCollectionByNameOrId('foods');\n"
            "  foods.fields.removeByName('preservation_probe');\n"
            "  app.save(foods);\n"
            "});\n",
            encoding="utf-8",
        )

        server = Server(directory, local_binary, data)
        server.start()
        try:
            applied = subprocess.run(
                ["sqlite3", str(data / "data.db"),
                 "SELECT count(*) FROM _migrations WHERE file LIKE '%preservation_probe%';"],
                text=True, capture_output=True, check=True,
            ).stdout.strip()
            assert applied == "1", f"the new migration was not applied to the existing database ({applied})"

            # Accounts are untouched because the database they live in is untouched.
            status, admin_auth = request(server.base, "POST", "/api/collections/_superusers/auth-with-password", {
                "identity": admin_email, "password": admin_password
            })
            assert status == 200, ("the superuser password did not survive the deployment", admin_auth)

            status, login = request(server.base, "POST", API + "/session", {
                "email": user_email, "password": user_password
            })
            assert status == 200, ("the account password did not survive the deployment", login)
            assert login["data"]["user"]["id"] == owner_id, "the account was replaced rather than kept"

            # And so does the session: nothing re-signs the tokens, so devices stay signed in.
            status, resumed = request(server.base, "POST", API + "/session/refresh", None, "Bearer " + token_before)
            assert status == 200, ("a session from before the deployment should still be valid", resumed)

            status, synced = request(server.base, "POST", API + "/sync", {
                "schemaVersion": 4, "deviceId": "device000000001", "since": 0,
                "changes": {"foods": [], "entries": [], "settings": None},
            }, "Bearer " + login["data"]["token"])
            assert status == 200, synced
            after = synced["data"]
            assert [food["name"] for food in after["changes"]["foods"]] == ["Oats"], after["changes"]["foods"]
            assert [entry["id"] for entry in after["changes"]["entries"]] == ["entry0000000001"], after["changes"]["entries"]
            assert after["changes"]["settings"]["targets"]["calories"] == 2000, after["changes"]["settings"]
            # The cursor counts within one database. A changed identity would make every device
            # start again from zero and re-upload everything it holds.
            assert after["datasetId"] == dataset_id, "the sync dataset identity changed across the deployment"
            assert after["cursor"] >= cursor_before, (after["cursor"], cursor_before)
        finally:
            server.stop()

    print("Calorie Logger data preservation suite passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
