import re
import subprocess
import unittest
from pathlib import Path


REPOSITORY = Path(__file__).parents[2]
IMMUTABLE_MODEL_VOCABULARY = "web/src/assets/potion/vocab.txt"

# This repository is public. Nothing tracked in it may name the machine, account, or address of a
# particular person's server -- not in code, not in documentation, and least of all in a test
# fixture, which is where a real address hides most comfortably because it looks like an example.
#
# Documentation ranges and obviously-fictional hosts are fine and are what the fixtures use; these
# patterns describe the shapes that are not.
FORBIDDEN = {
    # A bundle identifier under someone's own name rather than the product's.
    "a personal reverse-DNS identifier": re.compile(r"com\.(?!calorielogger)[a-z]+\.calorielogger", re.I),
    "a home directory path": re.compile(r"/(Users|home)/[a-z][a-z0-9_-]*/", re.I),
    # A personal mailbox. Fixtures use example.test, which is reserved for exactly this.
    "a personal email address": re.compile(
        r"[\w.+-]+@(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|proton|protonmail)\.[\w.]+", re.I
    ),
    # Real keys, not the words naming them.
    "something shaped like an API key": re.compile(r"\b(AIza[\w-]{30,}|sk-[A-Za-z0-9]{20,}|ghp_\w{30,})\b"),
}

# The one file that is allowed to talk about swap files is the rule that excludes them.
SWAP_FILE = re.compile(r"\.(swp|swo)$")

# Private addresses appear legitimately in the code that classifies them and in the tests for that
# code. What must not appear is one specific address used everywhere, which is what a real server
# looks like. These are the documentation-style fixtures the tests are allowed to use.
ALLOWED_PRIVATE_ADDRESSES = {
    "192.168.10.20", "10.0.0.5", "100.101.102.103",  # documentation-style test fixtures
    "100.64.0.0",  # the start of the shared address space, in the code that classifies addresses
    "127.0.0.1",
}
PRIVATE_ADDRESS = re.compile(r"\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|100\.\d{1,3}\.\d{1,3}\.\d{1,3})\b")


def tracked_text_files():
    listing = subprocess.run(
        ["git", "ls-files", "-z"], cwd=REPOSITORY, check=True, capture_output=True
    ).stdout.decode().split("\0")
    for relative in filter(None, listing):
        if relative in (IMMUTABLE_MODEL_VOCABULARY, "web/package-lock.json"):
            continue
        path = REPOSITORY / relative
        if not path.is_file():
            continue
        try:
            yield relative, path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue


class PrivateDetailTests(unittest.TestCase):
    def test_no_tracked_file_names_a_particular_person_or_machine(self):
        violations = []
        for relative, contents in tracked_text_files():
            if SWAP_FILE.search(relative):
                violations.append(f"{relative}: an editor swap file")
                continue
            for description, pattern in FORBIDDEN.items():
                for match in pattern.finditer(contents):
                    violations.append(f"{relative}: {description}: {match.group(0)!r}")
                    break
            for match in PRIVATE_ADDRESS.finditer(contents):
                if match.group(0) not in ALLOWED_PRIVATE_ADDRESSES:
                    violations.append(f"{relative}: an unrecognised private address {match.group(0)!r}")
        self.assertEqual(violations, [])

    def test_editor_swap_files_can_never_be_committed_again(self):
        """One was, and a Vim swap header carries the machine name and the home directory path."""
        ignored = (REPOSITORY / ".gitignore").read_text(encoding="utf-8")
        for pattern in ("*.swp", "*.swo"):
            self.assertIn(pattern, ignored)


if __name__ == "__main__":
    unittest.main()
