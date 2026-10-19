# Family NFL Pick'em

Live standings for the family's weekly 15-pick pool, graded against the spread.

Site: https://wintz320.github.io/pickem/

## How it updates

A GitHub Action (`.github/workflows/update.yml`) runs every 10 minutes during game windows and hourly otherwise. Each run:

1. Downloads the weekly Google Form responses from the pick sheet (the sheet's ID is stored in the `SHEET_ID` repository secret, and the sheet must be viewable by anyone with the link).
2. Pulls final scores from [nflverse](https://github.com/nflverse/nfldata) and live scores from ESPN's public scoreboard.
3. Writes `data.json` and redeploys the site if anything changed.

The page grades every pick in the browser. Each week's picks stay out of the public data until noon Sunday (Central).

## Changing things

Edit `config.json`:

- `players`: one entry per person. Add any new nickname someone uses to their `aliases` so their weeks stay together.
- `pushPoints`: points for a push (0 today).
- `void`: picks to throw out, written like `"W2:G16"` (Week 2, game 16).

You can run an update by hand from **Actions → Update leaderboard → Run workflow**.
