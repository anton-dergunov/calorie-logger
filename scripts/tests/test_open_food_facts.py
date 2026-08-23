from pathlib import Path
import subprocess
import unittest


REPOSITORY = Path(__file__).resolve().parents[2]


class OpenFoodFactsMappingTests(unittest.TestCase):
    def test_normalized_and_explicit_nutrition_mapping(self):
        subprocess.run(
            ["node", str(REPOSITORY / "scripts/tests/open_food_facts_mapping.cjs")],
            cwd=REPOSITORY,
            check=True,
        )


if __name__ == "__main__":
    unittest.main()
