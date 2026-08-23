import importlib.util
import math
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "prepare_cofid.py"
SPEC = importlib.util.spec_from_file_location("prepare_cofid", SCRIPT)
prepare_cofid = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(prepare_cofid)


class PrepareCoFIDTests(unittest.TestCase):
    def setUp(self):
        self.columns = {
            "Food Code": "A",
            "Food Name": "B",
            "Description": "C",
            "Group": "D",
            "PROT": "J",
            "FAT": "K",
            "CHO": "L",
            "KCALS": "M",
        }

    def test_trace_values_become_zero(self):
        row = {"A": "1", "B": "Herb", "C": "sample", "D": "H", "J": "Tr", "K": "0.1", "L": "2", "M": "10"}
        food = prepare_cofid.normalized_food(row, self.columns)
        self.assertEqual(food["protein"], 0)

    def test_unknown_or_invalid_core_values_are_rejected(self):
        for value in ("", "N", "-1", "not-a-number"):
            row = {"A": "1", "B": "Food", "C": "", "D": "A", "J": "1", "K": "1", "L": value, "M": "10"}
            self.assertIsNone(prepare_cofid.normalized_food(row, self.columns))
        self.assertIsNone(prepare_cofid.parse_nutrient(str(math.inf)))

    def test_alcoholic_groups_use_millilitres(self):
        row = {"A": "1", "B": "Cider", "C": "", "D": "QC", "J": "0", "K": "0", "L": "3", "M": "40"}
        self.assertEqual(prepare_cofid.normalized_food(row, self.columns)["unit"], "ml")
        row["D"] = "PC"
        self.assertEqual(prepare_cofid.normalized_food(row, self.columns)["unit"], "g")


if __name__ == "__main__":
    unittest.main()
