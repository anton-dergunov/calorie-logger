#!/usr/bin/env python3
"""Try the server's food-estimate prompt against Gemini over a fixture of descriptions.

This is a development tool for tuning the prompt, not part of `npm test`: it spends real model
calls and its output is a judgement, not an assertion. The prompt, model, and response schema are
read straight out of `pocketbase/pb_hooks/calorie-logger.js`, so what is measured here is exactly
what the server sends.

    AI_API_KEY=... python3 -B scripts/check_food_estimates.py [--only SUBSTRING] [--repeat N]
    AI_API_KEY=... python3 -B scripts/check_food_estimates.py --images ~/photos [--say TEXT]

Only the Gemini shape is exercised here. The server supports OpenAI-compatible endpoints too, but
this tool exists to tune the prompt, and tuning it against one model at a time is the point.

`--images` runs every picture in a directory instead of the fixtures, which is how the wording
is tuned against the three cases that matter: a plate of food, a packet's nutrition panel, and a
recipe or article. Nothing is asserted there -- the estimates are printed for reading.

Energy is calculated from the macros, exactly as the app does, and each row is checked for the
obvious ways an estimate can be useless: a refusal for real food, numbers for something that is
not food, an implausible portion, or a name that came back empty.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections import deque
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[1]
HOOK = REPOSITORY / "pocketbase/pb_hooks/calorie-logger.js"
# The free tier starts refusing at around this rate, and a refused call teaches nothing about
# the prompt. The server itself never retries a refusal, so pacing belongs here.
CALLS_PER_MINUTE = 10

# description, expected: True for food, False for a refusal, and a plausible kcal range.
FIXTURES: list[tuple[str, bool, tuple[float, float] | None]] = [
    ("a medium banana", True, (70, 150)),
    ("two slices of wholemeal toast with butter", True, (200, 450)),
    ("a bowl of porridge made with milk, with a sliced banana and a spoon of honey", True, (350, 700)),
    ("large flat white", True, (80, 250)),
    ("half a rotisserie chicken, no skin", True, (350, 900)),
    ("chicken tikka masala with pilau rice from a restaurant", True, (700, 1600)),
    ("a handful of almonds", True, (120, 350)),
    ("3 squares of dark chocolate", True, (80, 250)),
    ("leftover lasagne, about half of a normal portion", True, (200, 550)),
    # Energy is calculated from the macros, and alcohol is not one of them, so a pint comes to
    # far less than its real energy. The model is asked to say so in its note instead.
    ("a pint of lager", True, (50, 130)),
    ("small pot of greek yoghurt with berries", True, (100, 350)),
    ("veggie burrito from a takeaway", True, (500, 1200)),
    ("two boiled eggs", True, (120, 200)),
    ("a slice of my colleague's birthday cake", True, (250, 600)),
    ("miso soup", True, (25, 120)),
    ("60g dry pasta cooked with pesto", True, (350, 700)),
    ("an apple and a satsuma", True, (80, 200)),
    ("protein shake with water, one scoop", True, (90, 200)),
    ("fish and chips", True, (700, 1600)),
    ("a bowl of chilli with rice and sour cream", True, (500, 1100)),
    ("cup of tea with semi skimmed milk", True, (5, 60)),
    ("four chicken nuggets", True, (150, 350)),
    ("a spoonful of peanut butter", True, (80, 220)),
    ("my new bicycle", False, None),
    ("something", False, None),
]


def hook_source() -> str:
    return HOOK.read_text()


def prompt_from_hook(source: str) -> str:
    """The instruction lines exactly as the hook joins them."""
    block = re.search(r"const ESTIMATE_INSTRUCTIONS = \[(.*?)\]\.join\(\"\\n\"\);", source, re.S)
    if not block:
        raise SystemExit("Could not find ESTIMATE_INSTRUCTIONS in the hook.")
    lines = re.findall(r'^\s*"((?:[^"\\]|\\.)*)",\s*$', block.group(1), re.M)
    return "\n".join(json.loads(f'"{line}"') for line in lines)


def schema_from_hook(source: str) -> dict:
    block = re.search(r"const ESTIMATE_SCHEMA = (\{.*?\n\});", source, re.S)
    if not block:
        raise SystemExit("Could not find ESTIMATE_SCHEMA in the hook.")
    text = block.group(1)
    text = re.sub(r"(\w+):", r'"\1":', text)          # bare keys to JSON keys
    text = re.sub(r",(\s*[}\]])", r"\1", text)        # trailing commas
    return json.loads(text)


def model_from_hook(source: str) -> str:
    found = re.search(r'const ESTIMATE_MODEL = "([^"]+)";', source)
    if not found:
        raise SystemExit("Could not find ESTIMATE_MODEL in the hook.")
    return os.environ.get("AI_MODEL") or os.environ.get("GEMINI_MODEL") or found.group(1)


_recent: deque[float] = deque()


def wait_for_a_slot() -> None:
    now = time.monotonic()
    while _recent and now - _recent[0] > 60:
        _recent.popleft()
    if len(_recent) >= CALLS_PER_MINUTE:
        time.sleep(max(0.0, 60 - (now - _recent[0])) + 0.5)
        wait_for_a_slot()
        return
    _recent.append(time.monotonic())


IMAGE_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}


def estimate(model: str, key: str, instructions: str, schema: dict, description: str,
             image: Path | None = None) -> dict:
    wait_for_a_slot()
    parts: list[dict] = []
    if image is not None:
        parts.append({"inline_data": {
            "mime_type": IMAGE_TYPES[image.suffix.lower()],
            "data": base64.b64encode(image.read_bytes()).decode(),
        }})
    parts.append({"text": description or "Estimate the food in this picture."})
    request = urllib.request.Request(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        data=json.dumps({
            "systemInstruction": {"parts": [{"text": instructions}]},
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": {
                "temperature": 0.2,
                "responseMimeType": "application/json",
                "responseSchema": schema,
            },
        }).encode(),
        headers={"Content-Type": "application/json", "x-goog-api-key": key},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.load(response)
    parts = payload["candidates"][0]["content"]["parts"]
    return json.loads("".join(part.get("text", "") for part in parts))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", help="run only fixtures whose description contains this text")
    parser.add_argument("--repeat", type=int, default=1, help="run each fixture this many times")
    parser.add_argument("--images", help="estimate every picture in this directory instead of the fixtures")
    parser.add_argument("--say", default="", help="with --images, the description to send alongside each picture")
    arguments = parser.parse_args()

    key = os.environ.get("AI_API_KEY") or os.environ.get("GEMINI_API_KEY")
    if not key:
        env = REPOSITORY / ".env"
        if env.is_file():
            for line in env.read_text().splitlines():
                name, _, value = line.partition("=")
                if name.strip() in ("AI_API_KEY", "GEMINI_API_KEY"):
                    key = value.strip()
    if not key:
        raise SystemExit("Set AI_API_KEY, or put it in the repository .env file.")

    source = hook_source()
    instructions, schema, model = prompt_from_hook(source), schema_from_hook(source), model_from_hook(source)

    if arguments.images:
        pictures = sorted(path for path in Path(arguments.images).expanduser().iterdir()
                          if path.suffix.lower() in IMAGE_TYPES)
        if not pictures:
            raise SystemExit(f"No JPEG, PNG, or WebP pictures in {arguments.images}.")
        print(f"{model}: {len(pictures)} picture(s)" + (f", described as \u201c{arguments.say}\u201d" if arguments.say else "") + "\n")
        for picture in pictures:
            try:
                result = estimate(model, key, instructions, schema, arguments.say, picture)
            except (urllib.error.HTTPError, urllib.error.URLError, KeyError, ValueError) as error:
                print(f"  FAILED  {picture.name}: {error}")
                continue
            protein, fat, carbs = (float(result.get(field, 0) or 0) for field in ("protein", "fat", "carbs"))
            print(f"  {picture.name}")
            if not result.get("recognised"):
                print(f"    no food recognised \u2014 {result.get('note') or 'no reason given'}\n")
                continue
            print(f"    {result.get('name', '')}  \u2014  {protein * 4 + fat * 9 + carbs * 4:.0f} kcal  "
                  f"P{protein:.1f} F{fat:.1f} C{carbs:.1f}  ({result.get('confidence', '')})")
            print(f"    {result.get('portion', '')}" + (f"\n    {result['note']}" if result.get("note") else "") + "\n")
        return 0

    fixtures = [item for item in FIXTURES if not arguments.only or arguments.only in item[0]]
    print(f"{model}: {len(fixtures)} descriptions × {arguments.repeat}\n")

    complaints = 0
    for description, is_food, plausible in fixtures:
        for _ in range(arguments.repeat):
            try:
                result = estimate(model, key, instructions, schema, description)
            except (urllib.error.HTTPError, urllib.error.URLError, KeyError, ValueError) as error:
                print(f"  FAILED  {description}: {error}")
                complaints += 1
                continue
            recognised = bool(result.get("recognised"))
            protein, fat, carbs = (float(result.get(key_, 0) or 0) for key_ in ("protein", "fat", "carbs"))
            calories = protein * 4 + fat * 9 + carbs * 4
            notes = []
            if recognised != is_food:
                notes.append("refused real food" if is_food else "estimated something that is not food")
            if recognised:
                if not str(result.get("name", "")).strip():
                    notes.append("no name")
                if not str(result.get("portion", "")).strip():
                    notes.append("no portion")
                if plausible and not plausible[0] <= calories <= plausible[1]:
                    notes.append(f"outside {plausible[0]:.0f}-{plausible[1]:.0f} kcal")
            complaints += len(notes)
            flag = "!" if notes else " "
            summary = (f"{result.get('name', ''):<38.38} {calories:6.0f} kcal  "
                       f"P{protein:5.1f} F{fat:5.1f} C{carbs:5.1f}  {result.get('confidence', ''):<6}"
                       if recognised else f"{'(not food)':<38.38}")
            print(f"{flag} {description[:44]:<44} {summary} {'; '.join(notes)}")
            if recognised and result.get("portion"):
                print(f"    {result['portion']}" + (f" — {result['note']}" if result.get("note") else ""))

    print(f"\n{complaints} thing(s) worth looking at.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
