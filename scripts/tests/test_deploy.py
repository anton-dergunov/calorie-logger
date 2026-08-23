import os
import shutil
import re
import subprocess
import tempfile
import unittest
from pathlib import Path


REPOSITORY = Path(__file__).parents[2]


class DeployTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        shutil.copy2(REPOSITORY / "deploy.sh", self.root / "deploy.sh")
        (self.root / "scripts").mkdir()
        shutil.copy2(
            REPOSITORY / "scripts/deploy-pocketbase-remote.sh",
            self.root / "scripts/deploy-pocketbase-remote.sh",
        )
        # deploy.sh reads one version identity for the whole run out of these two.
        shutil.copy2(REPOSITORY / "scripts/version.sh", self.root / "scripts/version.sh")
        shutil.copy2(REPOSITORY / "package.json", self.root / "package.json")
        checksum = subprocess.run(
            ["cksum", str(self.root / "scripts/deploy-pocketbase-remote.sh")],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.split()
        self.helper_checksum = " ".join(checksum[:2])
        (self.root / ".calorie-logger-deploy").write_text(
            "DEPLOY_TARGET=deployer@example.test\n", encoding="utf-8"
        )
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.ssh_log = self.root / "ssh.log"
        self.upload = self.root / "upload.tar.gz"
        self.helper_upload = self.root / "uploaded-helper.sh"

        self.write_executable(
            "npm",
            """#!/bin/sh
set -eu
if [ "${1:-}" = run ] && [ "${2:-}" = package:server ]; then
  mkdir -p build
  printf 'credential-free-release' > build/calorie-logger-pocketbase-server.tar.gz
fi
""",
        )
        self.write_executable(
            "ssh",
            """#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$CALORIE_LOGGER_TEST_SSH_LOG"
case "$*" in
  *"cksum /usr/local/sbin/deploy-calorie-logger"*)
    if [ -n "$CALORIE_LOGGER_TEST_HELPER_CHECKSUM" ]; then
      printf '%s /usr/local/sbin/deploy-calorie-logger\\n' "$CALORIE_LOGGER_TEST_HELPER_CHECKSUM"
    fi
    exit 0
    ;;
  *"sudo -n /usr/local/sbin/deploy-calorie-logger"*)
    payload=$(mktemp)
    cat > "$payload"
    if [ -s "$payload" ]; then
      cp "$payload" "$CALORIE_LOGGER_TEST_UPLOAD"
      rm -f "$payload"
      exit "${CALORIE_LOGGER_TEST_SSH_STATUS:-0}"
    fi
    rm -f "$payload"
    if [ -n "$CALORIE_LOGGER_TEST_HELPER_REPORT" ]; then
      printf 'deployment-helper-checksum: %s\\n' "$CALORIE_LOGGER_TEST_HELPER_REPORT"
    fi
    printf 'The deployment archive is empty.\\n' >&2
    exit 1
    ;;
  *"cat > /tmp/calorie-logger-release.tar.gz"*)
    cat > "$CALORIE_LOGGER_TEST_UPLOAD"
    exit 0
    ;;
  *"cat > /tmp/calorie-logger-deploy-helper.sh"*)
    cat > "$CALORIE_LOGGER_TEST_HELPER_UPLOAD"
    exit 0
    ;;
  *"/tmp/calorie-logger-deploy-helper.sh"*)
    exit "${CALORIE_LOGGER_TEST_SSH_STATUS:-0}"
    ;;
esac
exit 0
""",
        )

    def tearDown(self):
        self.temporary.cleanup()

    def write_executable(self, name, contents):
        path = self.bin / name
        path.write_text(contents, encoding="utf-8")
        path.chmod(0o755)

    @staticmethod
    def local_helper_checksum():
        result = subprocess.run(
            ["cksum", str(REPOSITORY / "scripts/deploy-pocketbase-remote.sh")],
            text=True, capture_output=True, check=True,
        )
        fields = result.stdout.split()
        return f"{fields[0]} {fields[1]}"

    def run_deploy(self, *arguments, ssh_status="0", helper_checksum=None, helper_report=None):
        environment = os.environ.copy()
        environment.update(
            {
                "PATH": f"{self.bin}:/usr/bin:/bin",
                "CALORIE_LOGGER_TEST_SSH_LOG": str(self.ssh_log),
                "CALORIE_LOGGER_TEST_UPLOAD": str(self.upload),
                "CALORIE_LOGGER_TEST_SSH_STATUS": ssh_status,
                "CALORIE_LOGGER_TEST_HELPER_REPORT": (
                    self.local_helper_checksum() if helper_report is None else helper_report
                ),
                "CALORIE_LOGGER_TEST_HELPER_CHECKSUM": self.helper_checksum if helper_checksum is None else helper_checksum,
                "CALORIE_LOGGER_TEST_HELPER_UPLOAD": str(self.helper_upload),
            }
        )
        return subprocess.run(
            [str(self.root / "deploy.sh"), *arguments],
            cwd=self.root,
            env=environment,
            text=True,
            input="",
            capture_output=True,
            check=False,
        )

    def test_installed_passwordless_helper_is_used_without_a_prompt(self):
        result = self.run_deploy()

        self.assertEqual(result.returncode, 0, result.stderr)
        command = self.ssh_log.read_text(encoding="utf-8")
        self.assertIn("-T deployer@example.test", command)
        self.assertIn("sudo -n /usr/local/sbin/deploy-calorie-logger", command)
        self.assertNotIn("sudo sh /tmp/", command)
        self.assertEqual(self.upload.read_bytes(), b"credential-free-release")

    def test_a_server_with_no_helper_deploys_over_ordinary_sudo(self):
        """Nothing has to be installed on a server first. That is the whole point of the change:
        the hardened helper is an optimisation, not a prerequisite."""
        result = self.run_deploy(helper_checksum="", helper_report="")

        self.assertEqual(result.returncode, 0, result.stderr)
        command = self.ssh_log.read_text(encoding="utf-8")
        self.assertIn('run="sudo sh"', command)
        self.assertIn("/tmp/calorie-logger-deploy-helper.sh < /tmp/calorie-logger-release.tar.gz", command)
        # The helper is uploaded with the release rather than being expected to exist already.
        self.assertEqual(self.upload.read_bytes(), b"credential-free-release")
        self.assertIn("deploy-calorie-logger accepts only --reset-data", self.helper_upload.read_text(encoding="utf-8"))
        # A password prompt needs a real terminal, so this one path must allocate one.
        self.assertIn("-t deployer@example.test", command)
        # Both uploads are removed afterwards, whether or not the deployment worked.
        self.assertIn("rm -f /tmp/calorie-logger-release.tar.gz /tmp/calorie-logger-deploy-helper.sh", command)

    def test_remote_deployment_failure_is_reported_against_the_server(self):
        result = self.run_deploy(ssh_status="1")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("The deployment failed", result.stderr)
        self.assertIn("deployer@example.test", result.stderr)

    def test_outdated_helper_stops_before_build_or_upload(self):
        """A stale helper can run a current release the wrong way, so it is never used silently."""
        result = self.run_deploy(helper_checksum="1 2")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("out of date", result.stderr)
        self.assertIn("docs/setup.md", result.stderr)
        self.assertFalse(self.upload.exists())

    def test_unreadable_root_owned_helper_is_asked_to_identify_itself(self):
        """Synology hides /usr/local/sbin from the deployment account, so the checksum has to come
        from the helper itself."""
        result = self.run_deploy(helper_checksum="")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("sudo -n /usr/local/sbin/deploy-calorie-logger", self.ssh_log.read_text(encoding="utf-8"))
        self.assertEqual(self.upload.read_bytes(), b"credential-free-release")

    def test_unreadable_helper_that_reports_a_different_build_stops_the_deployment(self):
        result = self.run_deploy(helper_checksum="", helper_report="1 2")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("out of date", result.stderr)
        self.assertFalse(self.upload.exists())

    def test_hardening_appendix_streams_over_ssh_and_uses_the_real_account(self):
        instructions = (REPOSITORY / "docs/setup.md").read_text(encoding="utf-8")

        self.assertIn("cat > /tmp/deploy-calorie-logger", instructions)
        self.assertIn("deployment_user=${SUDO_USER:?", instructions)
        self.assertIn('printf \'%s ALL=(root) NOPASSWD:', instructions)
        self.assertNotIn("scp scripts/deploy-pocketbase-remote.sh", instructions)
        self.assertNotIn("'user ALL=(root)", instructions)

    def test_remote_health_check_accepts_json_keys_in_any_order(self):
        source = (REPOSITORY / "scripts/deploy-pocketbase-remote.sh").read_text(encoding="utf-8")
        start = source.index("health_is_ready() {")
        end = source.index("\n}\n", start) + 3
        function = source[start:end]

        preamble = 'api_version=3\n' + function + '\nhealth_is_ready "$1"'
        for response in (
            '{"data":{"apiVersion":3,"schemaVersion":1,"service":"calorie-logger","status":"ok"}}',
            '{"data":{"service":"calorie-logger","status":"ok","apiVersion":3}}',
        ):
            result = subprocess.run(["sh", "-c", preamble, "health-check", response], check=False)
            self.assertEqual(result.returncode, 0, response)

        for response in (
            '{"data":{"apiVersion":3,"service":"other","status":"ok"}}',
            # A server still serving an older or newer contract must not pass, and a longer
            # number must not satisfy the check by prefix.
            '{"data":{"apiVersion":2,"service":"calorie-logger","status":"ok"}}',
            '{"data":{"apiVersion":30,"service":"calorie-logger","status":"ok"}}',
        ):
            rejected = subprocess.run(["sh", "-c", preamble, "health-check", response], check=False)
            self.assertNotEqual(rejected.returncode, 0, response)

    def test_remote_deployment_recreates_the_container_from_the_new_image(self):
        source = (REPOSITORY / "scripts/deploy-pocketbase-remote.sh").read_text(encoding="utf-8")

        self.assertIn("up -d --force-recreate", source)
        self.assertIn('echo "Last v$api_version health response:', source)

    def test_remote_deployment_keeps_the_database_and_backs_it_up_first(self):
        """The app is in use: a deployment must never be the thing that loses the log."""
        source = (REPOSITORY / "scripts/deploy-pocketbase-remote.sh").read_text(encoding="utf-8")

        self.assertIn('data_path="$install_root/pb_data"', source)
        # The guard is a shape, not a list of two servers, so a NAS, a Pi, and a rented box can
        # each use their own layout without the destructive steps losing their safety rail.
        self.assertIn('/*/calorie-logger/pb_data) ;;', source)
        self.assertIn('backup_root="$install_root/backups"', source)
        self.assertIn('copy_database "$data_path/data.db" "$backup/data.db"', source)

        # Deletion happens in exactly one place, and only when it was asked for.
        self.assertEqual(1, len(re.findall(r'^\s*rm -rf "\$data_path"', source, re.M)))
        self.assertLess(source.index('if [ "$reset_data" = true ]; then'), source.index('rm -rf "$data_path"'))

        # The container is stopped before the copy, so the database is at rest, and the copy
        # happens before anything else can touch it.
        self.assertLess(source.index('docker stop "$old_container"'), source.index('backup="$backup_root/'))
        self.assertLess(source.index('backup="$backup_root/'), source.index("up -d --force-recreate"))

    def test_remote_deployment_accepts_only_the_reset_flag(self):
        source = (REPOSITORY / "scripts/deploy-pocketbase-remote.sh").read_text(encoding="utf-8")

        self.assertIn("--reset-data) reset_data=true ;;", source)
        self.assertIn("deploy-calorie-logger accepts only --reset-data", source)

    def test_deploy_confirms_before_asking_for_a_reset(self):
        """Nothing else in the workflow can lose the log, so this one asks out loud."""
        source = (REPOSITORY / "deploy.sh").read_text(encoding="utf-8")

        self.assertIn("--reset-data) reset_data=true ;;", source)
        self.assertIn('helper_arguments=" --reset-data"', source)
        self.assertIn('[ "$confirmation" = "DELETE" ]', source)
        self.assertLess(source.index('[ "$confirmation" = "DELETE" ]'), source.index("Uploading to $DEPLOY_TARGET"))

    def test_remote_health_check_follows_the_release_rather_than_a_pinned_version(self):
        """An API version bump must not require re-installing the root-owned helper by hand."""
        source = (REPOSITORY / "scripts/deploy-pocketbase-remote.sh").read_text(encoding="utf-8")

        self.assertIn('"$release/pocketbase/pb_hooks/calorie-logger.js"', source)
        self.assertIn('/api/calorie-logger/v$api_version/health', source)
        self.assertNotIn("/api/calorie-logger/v3/health", source)

    def test_helper_reports_its_own_checksum_before_touching_the_server(self):
        """Synology hides /usr/local/sbin, so this is the only staleness signal deploy.sh gets."""
        helper = REPOSITORY / "scripts/deploy-pocketbase-remote.sh"
        source = helper.read_text(encoding="utf-8")
        self.assertLess(source.index("deployment-helper-checksum:"), source.index('cat > "$archive"'))

        with tempfile.TemporaryDirectory() as directory:
            copy = Path(directory) / "deploy-calorie-logger"
            copy.write_text(source, encoding="utf-8")
            copy.chmod(0o755)
            result = subprocess.run([str(copy)], input="", text=True, capture_output=True, check=False)
            expected = subprocess.run(["cksum", str(copy)], text=True, capture_output=True, check=True)

        fields = expected.stdout.split()
        self.assertIn(f"deployment-helper-checksum: {fields[0]} {fields[1]}", result.stdout)
        self.assertEqual(f"{fields[0]} {fields[1]}", self.local_helper_checksum())

    def test_deploy_verifies_an_unreadable_helper_instead_of_trusting_it(self):
        source = (REPOSITORY / "deploy.sh").read_text(encoding="utf-8")

        self.assertIn('deployment-helper-checksum: $local_helper_checksum', source)
        self.assertIn('installed_helper=stale', source)
        self.assertNotIn("continuing through restricted sudo", source)

    def test_deployment_no_longer_stashes_accounts_around_a_wipe(self):
        """Accounts survive because the database does; the copy-forward machinery is gone."""
        source = (REPOSITORY / "scripts/deploy-pocketbase-remote.sh").read_text(encoding="utf-8")

        self.assertNotIn("for table in _superusers users; do", source)
        self.assertNotIn("INTERSECT", source)
        self.assertNotIn("account_restore_script", source)
        # An earlier release's stash is cleaned up rather than left to confuse the next one.
        self.assertIn('rm -f "$install_root/previous-accounts.db$suffix"', source)
        self.assertIn("Accounts, foods, log entries, and targets were kept", source)

        self.assertNotIn("INSERT OR IGNORE INTO users (id, email", source)

    def test_container_image_provides_the_tool_the_restore_needs(self):
        dockerfile = (REPOSITORY / "pocketbase/Dockerfile").read_text(encoding="utf-8")
        self.assertIn("sqlite", dockerfile)

    def test_server_has_one_complete_frozen_schema_bootstrap(self):
        migrations = sorted((REPOSITORY / "pocketbase/pb_migrations").glob("*.js"))

        # The baseline bootstrap is never edited once a database has run it, but later upgrade
        # migrations are expected as the schema evolves, so only its own content is asserted here.
        self.assertEqual(migrations[0].name, "1724140800_calorie_logger_schema.js")
        source = migrations[0].read_text(encoding="utf-8")
        self.assertIn("idx_entries_owner_food", source)
        self.assertNotIn("findAllRecords", source)
        self.assertNotIn('name: "food_id"', source)
        # Replication needs the pull cursor indexed, and cannot tolerate a uniqueness rule that
        # two offline devices could both satisfy.
        self.assertIn("idx_foods_owner_revision", source)
        self.assertIn("idx_entries_owner_revision", source)
        self.assertNotIn("idx_foods_owner_source", source)

    def test_local_mode_needs_no_ssh_and_keeps_the_database(self):
        """Running Calorie Logger on the machine in front of you is a supported install, not a
        development shortcut, so it backs up and health-checks like a deployment does."""
        source = (REPOSITORY / "deploy.sh").read_text(encoding="utf-8")

        self.assertIn("--local) mode=local ;;", source)
        local = source[source.index("deploy_local() {"):source.index("wait_for_health() {")]
        self.assertNotIn("ssh", local)
        self.assertIn("up -d --build --force-recreate", local)
        self.assertIn('backup="$install_root/backups/', local)
        self.assertLess(local.index('backup="$install_root/backups/'), local.index('rm -rf "$install_root/pb_data"'))
        # The listener stays on loopback unless it is deliberately opened up.
        self.assertIn('bind_address=${CALORIE_LOGGER_BIND:-127.0.0.1}', local)

    def test_a_release_publishes_the_desktop_application_without_withdrawing_the_old_one(self):
        helper = (REPOSITORY / "scripts/deploy-pocketbase-remote.sh").read_text(encoding="utf-8")
        packager = (REPOSITORY / "scripts/package-pocketbase-server.sh").read_text(encoding="utf-8")

        # Deploying from Linux cannot build a macOS application; that must not remove the one
        # people are already downloading.
        self.assertIn('if [ -f "$release/downloads/release.json" ]; then', helper)
        self.assertIn('elif [ -f "$downloads_path/release.json" ]; then', helper)
        self.assertIn('if [ -f "$repo_dir/build/macos-release/release.json" ]; then', packager)
        # Served from its own directory, never from pb_public, which the service worker precaches.
        self.assertIn("CALORIE_LOGGER_DOWNLOADS_PATH=$downloads_path", helper)

    def test_the_release_carries_the_version_the_server_reports(self):
        packager = (REPOSITORY / "scripts/package-pocketbase-server.sh").read_text(encoding="utf-8")
        helper = (REPOSITORY / "scripts/deploy-pocketbase-remote.sh").read_text(encoding="utf-8")

        self.assertIn('"$bundle/version.json"', packager)
        self.assertIn('"$release/version.json"', helper)
        self.assertIn("CALORIE_LOGGER_VERSION=${app_version:-0.0.0}", helper)

    def test_shell_scripts_parse(self):
        for relative_path in (
            "deploy.sh",
            "scripts/deploy-pocketbase-remote.sh",
            "scripts/version.sh",
            "scripts/package-pocketbase-server.sh",
            "scripts/stage-pocketbase.sh",
        ):
            result = subprocess.run(
                ["sh", "-n", str(REPOSITORY / relative_path)],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
