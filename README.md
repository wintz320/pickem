# Family NFL Pick'em

Live standings for the family's weekly 15-pick pool, graded against the spread.

Site: https://wintz320.github.io/pickem/

## Making picks

Everyone picks on **picks.html** (the "Make your picks" button). The page shows the week's games with team logos, DraftKings spreads and totals, and a 15-pick counter. Each game locks at kickoff.

Picks are stored in Brandon's Google Sheet, **NFL Pick'em 2026 (Brandon)** (its ID is `sheetId` in `config.json`; it must be viewable by anyone with the link). Behind the pick page is a small Google Apps Script inside that sheet (`apps-script/Code.gs`):

- Every hour it checks whether next week's lines should lock. At 6 PM Central on Wednesday it copies DraftKings' numbers from ESPN into a **Lines Wk N** tab. Change any number in that tab and the pick page uses it.
- Each submission becomes a row in **Picks Wk N**, in the same format the old Google Form used. The latest submission per person counts.
- The **Players** tab is the list of names on the pick page. Add a row to add a player (and add their name to `config.json`).

The script's web app URL goes in `config.json` as `picksApi`. Until it's set, the pick page shows a preview with live lines.

## How it updates

- **Live scores:** while the page is open, it fetches the current week's scoreboard from ESPN about once a minute and grades every pick in the browser.
- **Picks and saved results:** a GitHub Action (`.github/workflows/update.yml`) downloads the week's picks from the pick sheet (the Picks Wk tabs, plus the Form Responses tabs from earlier weeks), pulls final scores from [nflverse](https://github.com/nflverse/nfldata) and ESPN, writes `data.json`, and redeploys the site when anything changed. The sheet's ID comes from `sheetId` in `config.json`.
- **Timing:** the Action is scheduled every 10 minutes on game days and hourly otherwise, but GitHub runs schedules on a best-effort basis, so runs can come late or be skipped. A Claude scheduled task also starts it right after noon on Sundays.

Each week's picks stay out of the public data until noon Sunday (Central).

## Changing things

Edit `config.json`:

- `players`: one entry per person. Add any new nickname someone uses to their `aliases` so their weeks stay together.
- `pushPoints`: points for a push (0 today).
- `void`: picks to throw out, written like `"W2:G16"` (Week 2, game 16).

You can run an update by hand from **Actions → Update leaderboard → Run workflow**.
