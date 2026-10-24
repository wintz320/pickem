#!/usr/bin/env python3
"""Add one-line game news for a week to news.json.

Usage: python3 scripts/set_news.py --week 7 --items items.json

items.json is a list like:
  [{"game": "PIT@NO", "news": "Steelers QB ... is out.", "source": "https://...", "published": "2026-10-23"}]
"game" is AWAY@HOME with the leaderboard's team codes (LA = Rams, WAS = Commanders); ESPN's
LAR / WSH / JAC also work. Items with no news are skipped. Each game must be on that week's
schedule in data.json, or the script stops without changing anything.
"""
import argparse
import datetime as dt
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CODE = {"LAR": "LA", "WSH": "WAS", "JAC": "JAX", "LVR": "LV"}
MAX_CHARS = 160


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--week", type=int, required=True)
    ap.add_argument("--items", required=True)
    a = ap.parse_args()

    with open(os.path.join(ROOT, "data.json"), encoding="utf-8") as f:
        games = [g for g in json.load(f)["games"] if g["week"] == a.week]
    valid = {g["away"] + "@" + g["home"] for g in games}
    with open(a.items, encoding="utf-8") as f:
        items = json.load(f)

    path = os.path.join(ROOT, "news.json")
    news = {"weeks": {}}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            news = json.load(f)
    week = news.setdefault("weeks", {}).setdefault(str(a.week), {})

    problems, added = [], 0
    for it in items:
        away, _, home = str(it.get("game", "")).upper().partition("@")
        key = CODE.get(away, away) + "@" + CODE.get(home, home)
        text = " ".join(str(it.get("news") or "").split())
        if not text or text.lower() == "null":
            continue
        if key not in valid:
            problems.append("%s isn't a week %d game (valid: %s)" % (it.get("game"), a.week, ", ".join(sorted(valid))))
            continue
        if len(text) > MAX_CHARS:
            problems.append("%s: news is %d characters; keep it to one short sentence" % (key, len(text)))
            continue
        week[key] = {"text": text, "source": it.get("source") or "", "published": it.get("published") or ""}
        added += 1
    if problems:
        print("NOT SAVED:\n  " + "\n  ".join(problems))
        sys.exit(1)

    # keep the last few weeks only
    for w in list(news["weeks"]):
        if int(w) < a.week - 2:
            del news["weeks"][w]
    news["updatedAt"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(news, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print("saved %d news lines for week %d (%d games on file for that week)" % (added, a.week, len(week)))


if __name__ == "__main__":
    main()
