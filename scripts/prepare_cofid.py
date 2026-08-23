#!/usr/bin/env python3
"""Convert the official CoFID 2021 workbook into Calorie Logger's compact search catalogue."""

from __future__ import annotations

import argparse
import json
import math
import re
from pathlib import Path
from typing import Iterator
from xml.etree import ElementTree as ET
from zipfile import ZipFile

MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
SHEET_NAME = "1.3 Proximates"
EXPECTED_COUNT = 2_853
SOURCE_URL = "https://www.gov.uk/government/publications/composition-of-foods-integrated-dataset-cofid"


def column_name(reference: str) -> str:
    return "".join(character for character in reference if character.isalpha())


def parse_nutrient(value: str) -> float | None:
    value = value.strip()
    if value == "Tr":
        return 0.0
    if value in {"", "N"}:
        return None
    try:
        number = float(value)
    except ValueError:
        return None
    return number if math.isfinite(number) and number >= 0 else None


def normalized_food(row: dict[str, str], columns: dict[str, str]) -> dict[str, object] | None:
    nutrients = {
        "calories": parse_nutrient(row.get(columns["KCALS"], "")),
        "protein": parse_nutrient(row.get(columns["PROT"], "")),
        "fat": parse_nutrient(row.get(columns["FAT"], "")),
        "carbs": parse_nutrient(row.get(columns["CHO"], "")),
    }
    if any(value is None for value in nutrients.values()):
        return None

    code = row.get(columns["Food Code"], "").strip()
    name = row.get(columns["Food Name"], "").strip()
    if not code or not name:
        return None
    group = row.get(columns["Group"], "").strip()
    return {
        "id": code,
        "name": name,
        "description": row.get(columns["Description"], "").strip(),
        "basisAmount": 100,
        "unit": "ml" if group.startswith("Q") else "g",
        **nutrients,
    }


def worksheet_rows(workbook: Path) -> Iterator[dict[str, str]]:
    with ZipFile(workbook) as archive:
        shared_root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
        shared_strings = [
            "".join(node.text or "" for node in item.iter(f"{{{MAIN_NS}}}t"))
            for item in shared_root
        ]

        workbook_root = ET.fromstring(archive.read("xl/workbook.xml"))
        relationships_root = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        targets = {item.attrib["Id"]: item.attrib["Target"] for item in relationships_root}
        sheets = workbook_root.find(f"{{{MAIN_NS}}}sheets")
        if sheets is None:
            raise ValueError("Workbook has no worksheets")
        sheet = next((item for item in sheets if item.attrib.get("name") == SHEET_NAME), None)
        if sheet is None:
            raise ValueError(f"Missing worksheet: {SHEET_NAME}")
        relationship_id = sheet.attrib[f"{{{REL_NS}}}id"]
        target = targets[relationship_id]
        worksheet_root = ET.fromstring(archive.read(f"xl/{target}"))
        sheet_data = worksheet_root.find(f"{{{MAIN_NS}}}sheetData")
        if sheet_data is None:
            raise ValueError(f"Worksheet {SHEET_NAME} has no rows")

        for xml_row in sheet_data:
            row: dict[str, str] = {}
            for cell in xml_row:
                reference = cell.attrib.get("r", "")
                value_node = cell.find(f"{{{MAIN_NS}}}v")
                if not reference or value_node is None or value_node.text is None:
                    continue
                value = value_node.text
                if cell.attrib.get("t") == "s":
                    value = shared_strings[int(value)]
                row[column_name(reference)] = value
            yield row


def convert(workbook: Path, expected_count: int | None = EXPECTED_COUNT) -> dict[str, object]:
    rows = list(worksheet_rows(workbook))
    if len(rows) < 4:
        raise ValueError(f"Worksheet {SHEET_NAME} is unexpectedly short")

    columns: dict[str, str] = {}
    for column, label in rows[0].items():
        if label in {"Food Code", "Food Name", "Description", "Group"}:
            columns[label] = column
    for column, label in rows[1].items():
        if label in {"KCALS", "PROT", "FAT", "CHO"}:
            columns[label] = column

    required = {"Food Code", "Food Name", "Description", "Group", "KCALS", "PROT", "FAT", "CHO"}
    missing = sorted(required - columns.keys())
    if missing:
        raise ValueError(f"Missing expected CoFID columns: {', '.join(missing)}")

    foods = [food for row in rows[3:] if (food := normalized_food(row, columns)) is not None]
    foods.sort(key=lambda food: (str(food["name"]).casefold(), str(food["id"])))
    if expected_count is not None and len(foods) != expected_count:
        raise ValueError(f"Expected {expected_count} importable foods, found {len(foods)}")
    return {
        "source": "CoFID",
        "version": "2021",
        "sourceURL": SOURCE_URL,
        "foods": foods,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workbook", type=Path, help="Path to the official CoFID 2021 .xlsx workbook")
    parser.add_argument("output", type=Path, help="Destination JSON catalogue")
    parser.add_argument("--expected-count", type=int, default=EXPECTED_COUNT)
    arguments = parser.parse_args()

    catalogue = convert(arguments.workbook, arguments.expected_count)
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(
        json.dumps(catalogue, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {len(catalogue['foods'])} foods to {arguments.output}")


if __name__ == "__main__":
    main()
