# Family NFL Pick'em

Live standings for the family's weekly 15-pick pool, graded against the spread.

Site: https://wintz320.github.io/pickem/

## How it updates

- **Live scores:** while the page is open, it fetches the current week's scoreboard from ESPN about once a minute and grades every pick in the browser.
- **Picks and saved results:** a GitHub Action (`.github/workflows/update.yml`) downloads the weekly Google Form responses from the pick sheet, pulls final scores from [nflverse](https://github.com/nflverse/nfldata) and ESPN, writes `data.json`, and redeploys the site when anything changed. The sheet's ID is stored in the `SHEET_ID` repository secret, and the sheet must be viewable by anyone with the link.
- **Timing:** the Action is scheduled every 10 minutes on game days and hourly otherwise, but GitHub runs schedules on a best-effort basis, so runs can come late or be skipped. A Claude scheduled task also starts it right after noon on Sundays.

Each week's picks stay out of the public data until noon Sunday (Central).

## Changing things

Edit `config.json`:

- `players`: one entry per person. Add any new nickname someone uses to their `aliases` so their weeks stay together.
- `pushPoints`: points for a push (0 today).
- `void`: picks to throw out, written like `"W2:G16"` (Week 2, game 16).

You can run an update by hand from **Actions → Update leaderboard → Run workflow**.
