import subprocess
import unittest
from pathlib import Path


REPOSITORY = Path(__file__).parents[2]
FORBIDDEN = bytes((100, 97, 105, 108, 121)).decode("ascii")
IMMUTABLE_MODEL_VOCABULARY = "web/src/assets/potion/vocab.txt"


class ForbiddenNameTests(unittest.TestCase):
    def test_former_name_is_absent_from_tracked_paths_and_text(self):
        tracked = subprocess.run(
            ["git", "ls-files", "-z"],
            cwd=REPOSITORY,
            check=True,
            capture_output=True,
        ).stdout.decode().split("\0")
        violations = []
        for relative in filter(None, tracked):
            if relative == IMMUTABLE_MODEL_VOCABULARY:
                continue
            path = REPOSITORY / relative
            if not path.exists():
                continue
            if FORBIDDEN in relative.lower():
                violations.append(relative)
                continue
            try:
                contents = path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, IsADirectoryError):
                continue
            if FORBIDDEN in contents.lower():
                violations.append(relative)
        self.assertEqual(violations, [])


if __name__ == "__main__":
    unittest.main()
