#!/usr/bin/env python3
"""Rebuild data.json for the pick'em site.

Inputs (fetched fresh on every run):
  - the week's picks from the pick sheet: "Picks Wk N" tabs written by the pick page's sheet script,
    and "Form Responses N" tabs from the Google Forms used before that
  - final scores for the season (nflverse, an open NFL data project)
  - live and just-finished games for the current week (ESPN's public scoreboard feed)
The page grades every pick itself; this script only gathers raw inputs.

Each week's picks are kept out of the public data until noon Sunday (Central) of that week.
If a source can't be reached, the last good copy of that input is kept.

For local testing, point at files instead of the network:
  PICKEM_XLSX=path.xlsx  PICKEM_GAMES=games.csv  PICKEM_ESPN=scoreboard.json  PICKEM_NOW=ISO-time
"""
import csv
import datetime as dt
import io
import json
import os
import re
import sys
import urllib.request
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data.json")
CONFIG = os.path.join(ROOT, "config.json")
SEASON = 2026
CT = ZoneInfo("America/Chicago")
HEADERS = {"User-Agent": "family-pickem-leaderboard/1.0 (+https://github.com/wintz320/pickem)"}
ESPN_FIX = {"WSH": "WAS", "LAR": "LA", "JAC": "JAX", "LVR": "LV"}
TEAM_NICKS = {
    "cardinals": "ARI", "falcons": "ATL", "ravens": "BAL", "bills": "BUF", "panthers": "CAR",
    "bears": "CHI", "bengals": "CIN", "browns": "CLE", "cowboys": "DAL", "broncos": "DEN",
    "lions": "DET", "packers": "GB", "texans": "HOU", "colts": "IND", "jaguars": "JAX",
    "chiefs": "KC", "raiders": "LV", "chargers": "LAC", "rams": "LA", "dolphins": "MIA",
    "vikings": "MIN", "patriots": "NE", "saints": "NO", "giants": "NYG", "jets": "NYJ",
    "eagles": "PHI", "steelers": "PIT", "49ers": "SF", "seahawks": "SEA", "buccaneers": "TB",
    "titans": "TEN", "commanders": "WAS",
}
SIDE_RE = re.compile(r"^\s*G\s*\d+\s*\|\s*(.*?)\s*\((home|away)\)", re.I)


def warn(msg):
    print("::warning::" + msg)


def fetch(url, timeout=45):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def num(x):
    try:
        return int(x)
    except (TypeError, ValueError):
        try:
            return float(x)
        except (TypeError, ValueError):
            return None


def cell(v):
    if v is None:
        return ""
    if isinstance(v, dt.datetime):
        return "%d/%d/%d %d:%02d:%02d" % (v.month, v.day, v.year, v.hour, v.minute, v.second)
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def sheet_tabs():
    """All 'Picks Wk N' and 'Form Responses N' tabs from the pick sheet, as rows of [timestamp, name, picks]."""
    path = os.environ.get("PICKEM_XLSX")
    if path:
        raw = open(path, "rb").read()
    else:
        sheet_id = os.environ.get("SHEET_ID", "").strip()
        if not sheet_id:
            raise RuntimeError("SHEET_ID secret is not set")
        raw = fetch("https://docs.google.com/spreadsheets/d/%s/export?format=xlsx" % sheet_id, 90)
    if not raw.startswith(b"PK"):
        raise RuntimeError("the pick sheet isn't viewable by link (Google sent a sign-in page)")
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
    tabs = {}
    for ws in wb.worksheets:
        title = ws.title.strip()
        if not re.fullmatch(r"Form Responses \d+|Picks Wk \d+", title):
            continue
        rows = [[cell(v) for v in (list(r) + [None, None, None])[:3]]
                for r in ws.iter_rows(min_col=1, max_col=3, values_only=True)]
        while rows and not any(c.strip() for c in rows[-1]):
            rows.pop()
        tabs[title] = rows
    return tabs


def season_games():
    path = os.environ.get("PICKEM_GAMES")
    raw = open(path, "rb").read() if path else fetch(
        "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv", 90)
    out = []
    for r in csv.DictReader(io.StringIO(raw.decode("utf-8"))):
        if r.get("season") != str(SEASON) or r.get("game_type") != "REG":
            continue
        out.append({"id": r["game_id"], "week": int(r["week"]), "date": r["gameday"],
                    "weekday": r["weekday"], "timeET": r["gametime"], "away": r["away_team"],
                    "home": r["home_team"], "awayScore": num(r["away_score"]),
                    "homeScore": num(r["home_score"]), "totalLine": num(r["total_line"]),
                    "spreadLine": num(r["spread_line"])})
    return out


def apply_scoreboard(games):
    """Fold ESPN's current scoreboard into games (finals) and return in-progress games."""
    path = os.environ.get("PICKEM_ESPN")
    raw = open(path, "rb").read() if path else fetch(
        "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard", 30)
    board = json.loads(raw)
    live = {}
    for ev in board.get("events", []):
        try:
            comp = ev["competitions"][0]
            status = comp.get("status") or ev.get("status") or {}
            kind = status.get("type") or {}
            side = {c["homeAway"]: c for c in comp["competitors"]}
            home = ESPN_FIX.get(side["home"]["team"]["abbreviation"], side["home"]["team"]["abbreviation"])
            away = ESPN_FIX.get(side["away"]["team"]["abbreviation"], side["away"]["team"]["abbreviation"])
            when = dt.datetime.fromisoformat(ev["date"].replace("Z", "+00:00")).date()
        except (KeyError, IndexError, ValueError, TypeError):
            continue
        game = next((g for g in games if g["home"] == home and g["away"] == away
                     and abs((when - dt.date.fromisoformat(g["date"])).days) <= 2), None)
        if not game:
            continue
        hs, as_ = num(side["home"].get("score")), num(side["away"].get("score"))
        if hs is None or as_ is None:
            continue
        if kind.get("completed"):
            game["homeScore"], game["awayScore"] = hs, as_
        elif kind.get("state") == "in":
            period = num(status.get("period")) or 0
            if "HALFTIME" in str(kind.get("name", "")).upper():
                label = "Half"
            else:
                label = "OT" if period > 4 else ("Q%d" % period if period else "")
            live[game["id"]] = {"awayScore": as_, "homeScore": hs, "period": label,
                                "clock": status.get("displayClock") or ""}
    return live


def side_picks(cell_text):
    for chunk in re.split(r",\s*(?=G\s*\d+\s*\|)", str(cell_text or "")):
        m = SIDE_RE.match(chunk)
        if m:
            team = TEAM_NICKS.get(m.group(1).strip().lower().split(" ")[-1])
            if team:
                yield team, m.group(2).lower()


def tab_week(rows, by_week):
    best, best_score = None, 0
    for wk, gs in by_week.items():
        score = 0
        for r in rows[1:]:
            for team, role in side_picks(r[2] if len(r) > 2 else ""):
                if any((g["home"] if role == "home" else g["away"]) == team for g in gs):
                    score += 1
        if score > best_score:
            best, best_score = wk, score
    return best


def reveal_time(week_games):
    sundays = sorted(g["date"] for g in week_games if g["weekday"] == "Sunday")
    if not sundays:
        return None
    d = dt.date.fromisoformat(sundays[0])
    return dt.datetime(d.year, d.month, d.day, 12, 0, tzinfo=CT)


def main():
    now = dt.datetime.fromisoformat(os.environ["PICKEM_NOW"]) if os.environ.get("PICKEM_NOW") \
        else dt.datetime.now(dt.timezone.utc)
    old = {}
    if os.path.exists(DATA):
        with open(DATA, encoding="utf-8") as f:
            old = json.load(f)
    with open(CONFIG, encoding="utf-8") as f:
        config = json.load(f)
    problems = []

    try:
        games = season_games()
    except Exception as e:  # keep last good schedule/results
        problems.append("season results: %s" % e)
        games = old.get("games", [])
    # never lose a final score we already had
    prev = {g["id"]: g for g in old.get("games", [])}
    for g in games:
        p = prev.get(g["id"])
        if p and g.get("awayScore") is None and p.get("awayScore") is not None:
            g["awayScore"], g["homeScore"] = p["awayScore"], p["homeScore"]

    try:
        live = apply_scoreboard(games)
    except Exception as e:
        problems.append("live scoreboard: %s" % e)
        live = {}

    try:
        tabs = sheet_tabs()
    except Exception as e:
        problems.append("pick sheet: %s" % e)
        tabs = old.get("tabs", {})

    by_week = {}
    for g in games:
        by_week.setdefault(g["week"], []).append(g)
    public_tabs, tab_weeks, withheld = {}, {}, []
    for title, rows in tabs.items():
        named = re.fullmatch(r"Picks Wk (\d+)", title)
        wk = int(named.group(1)) if named else tab_week(rows, by_week)
        if wk is None:
            public_tabs[title] = rows
            continue
        tab_weeks[title] = wk
        reveal = reveal_time(by_week.get(wk, []))
        if reveal and now < reveal:
            public_tabs[title] = [rows[0]] + [[r[0], r[1], "HIDDEN" if (r[2] or "").strip() else ""] for r in rows[1:]]
            withheld.append(title)
        else:
            public_tabs[title] = rows

    data = {
        "version": 2,
        "pool": "NFL Pick'em",
        "season": SEASON,
        "config": config,
        "tabs": public_tabs,
        "tabWeeks": tab_weeks,
        "games": sorted(games, key=lambda g: (g["week"], g["date"], g["timeET"], g["id"])),
        "live": live,
    }
    comparable = lambda d: json.dumps({k: v for k, v in d.items() if k != "updatedAt"}, sort_keys=True)
    changed = comparable(data) != comparable(old)
    data["updatedAt"] = now.isoformat(timespec="seconds") if changed else old.get("updatedAt")
    if changed:
        with open(DATA, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))

    finals = sum(1 for g in games if g.get("awayScore") is not None)
    print("games %d, final %d, live %d, tabs %d, withheld %s, changed %s"
          % (len(games), finals, len(live), len(tabs), withheld or "none", changed))
    for p in problems:
        warn(p)
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as f:
            f.write("changed=%s\n" % ("true" if changed else "false"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
