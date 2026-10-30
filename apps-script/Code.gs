/**
 * Family NFL Pick'em: the pick sheet's backend.
 *
 * Lives inside the pick Google Sheet (Extensions > Apps Script) and is deployed as a web app.
 * - Every hour it checks whether next week's lines should lock (Wednesday 6 PM Central).
 *   When they do, it copies DraftKings' spreads and totals from ESPN into a "Lines Wk N" tab.
 *   You can change any number in that tab; the pick page always uses what the tab says.
 * - The pick page asks it for this week's games (GET ?action=slate).
 * - The pick page sends picks to it (POST). Each submission becomes a row in "Picks Wk N",
 *   written in the same format the old Google Form used, so the leaderboard reads it as before.
 *
 * Setup: paste this file, run setup() once, then Deploy > New deployment > Web app
 * (Execute as: Me, Who has access: Anyone) and send the web app URL to the site.
 * It can also live in its own project at script.google.com, owned by anyone who can edit
 * the pick sheet; it then finds the sheet by PICK_SHEET_ID.
 */

var TZ = 'America/Chicago';
var SEASON = 2026;
var NEED = 15;              // picks per week
var LOCK_WEEKDAY = 3;       // lines lock on Wednesday (Sunday = 0)
var LOCK_HOUR = 18;         // at 6 PM Central
var ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
// ESPN sometimes turns Google's servers away. The pick'em site keeps a copy of the upcoming week
// (data.json "upcoming", refreshed from ESPN by its hourly update), and the script uses that instead.
var SITE_DATA = 'https://wintz320.github.io/pickem/data.json';
var PICK_SHEET_ID = '1g2Joz-98g54pcfzs2Sb2EeG8zUT4m27k4HgDPOnMH8U';   // used when the script isn't inside the sheet
var PLAYERS_TAB = 'Players';
var DEFAULT_PLAYERS = ['Losing Hair Do Care', 'Fin Diesel', 'Pump up the Gam', 'Hollywood', "Long Hair Don't Care",
  'Boss Baby', 'Big Cheese', 'Glamorace', 'Super Max', 'Jet', 'Koala Bears'];
var LINES_HEADER = ['Game', 'Away', 'Away line', 'Home', 'Home line', 'Total', 'Kickoff',
  'Away team', 'Home team', 'Away logo', 'Home logo', 'ESPN id'];
var PICKS_HEADER = ['Timestamp', 'Your name', 'Your 15 picks', 'Picks (for the script)'];
var FIX = { WSH: 'WAS', LAR: 'LA', JAC: 'JAX' };   // match the leaderboard's team codes

function linesTab_(week) { return 'Lines Wk ' + week; }
function picksTab_(week) { return 'Picks Wk ' + week; }

/* ---------------- setup and the hourly check ---------------- */

/** Run once from the editor. Makes the Players tab (if missing) and the hourly check. */
function setup() {
  var ss = SpreadsheetApp.getActive() || SpreadsheetApp.openById(PICK_SHEET_ID);
  PropertiesService.getScriptProperties().setProperty('SHEET_ID', ss.getId());
  if (!ss.getSheetByName(PLAYERS_TAB)) {
    var sh = ss.insertSheet(PLAYERS_TAB);
    sh.getRange(1, 1).setValue('Player');
    sh.getRange(2, 1, DEFAULT_PLAYERS.length, 1).setValues(DEFAULT_PLAYERS.map(function (n) { return [n]; }));
    sh.setFrozenRows(1);
  }
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'hourly') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('hourly').timeBased().everyHours(1).create();
  hourly();
  var up = upcoming_();
  Logger.log('Ready. Week ' + up.week + ' lines lock ' + fmt_(up.lockAt, 'EEE MMM d h:mm a') + ' CT' +
    (up.source === 'site' ? ' (lines via the pick’em site, since ESPN turned this script away).' : ' (lines from ESPN).'));
}

/** Runs every hour: locks next week's lines once it's time. */
function hourly() {
  var up = upcoming_();
  if (!up.games.length || !up.lockAt) return;
  var nowMs = Date.now();
  if (nowMs < Date.parse(up.lockAt) || nowMs >= Date.parse(up.firstKickoff)) return;
  var ss = book_();
  if (ss.getSheetByName(linesTab_(up.week))) return;
  var games = weekGames_(up.week);
  if (!games.length) return;
  writeLines_(ss, up.week, games);
  CacheService.getScriptCache().remove('upcoming');
}

/** Optional: run from the editor to lock next week's lines right now instead of Wednesday. */
function lockLinesNow() {
  CacheService.getScriptCache().remove('upcoming');
  var up = upcoming_(), ss = book_();
  if (ss.getSheetByName(linesTab_(up.week))) { Logger.log('Week ' + up.week + ' lines are already locked.'); return; }
  writeLines_(ss, up.week, weekGames_(up.week));
  Logger.log('Locked week ' + up.week + ' lines.');
}

/* ---------------- web app ---------------- */

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'slate';
  try {
    if (action === 'slate') return json_(slateResponse_());
    if (action === 'selftest') return json_(selftest_());
    return json_({ ok: false, error: 'Unknown request.' });
  } catch (err) {
    console.error(err);
    var out = { ok: false, error: 'The pick sheet hit a problem. Try again in a minute.' };
    if (action === 'selftest') out.detail = String((err && err.message) || err);
    return json_(out);
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.action !== 'submit') return json_({ ok: false, error: 'Unknown request.' });
    return json_(submit_(book_(), body, new Date()));
  } catch (err) {
    if (!(err && err.user)) console.error(err);
    return json_({ ok: false, error: err && err.user ? err.message : 'Your picks didn’t save because the pick sheet hit a problem. Try again in a minute.' });
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

function slateResponse_() {
  var ss = book_(), st = state_(ss);
  var out = { ok: true, status: st.status, week: st.week, serverNow: new Date().toISOString(),
    players: players_(ss), submitted: [], games: st.games };
  if (st.status === 'open') {
    out.lockedAt = PropertiesService.getScriptProperties().getProperty('LOCKED_' + st.week) || null;
    out.submitted = submitted_(ss, st.week);
    out.carried = carried_(ss, st.week, st.games);
  }
  if (st.opensAt) out.opensAt = st.opensAt;
  return out;
}

/** Validates one submission and writes it as a row. body: {week, name, picks: [{n, pick}], dryRun?} */
function submit_(ss, body, now) {
  var st = state_(ss);
  if (st.status !== 'open') {
    if (!body.dryRun) throw userError_('Picks aren’t open yet. They open when the lines lock.');
    var up = upcoming_();
    st = { status: 'preview', week: up.week, games: up.games };
  }
  if (Number(body.week) !== st.week) throw userError_('This page is showing an old week. Reload it and pick again.');
  var name = String(body.name || '').trim();
  if (players_(ss).indexOf(name) < 0) throw userError_('Tap your name in the list first.');
  var byN = {};
  st.games.forEach(function (g) { byN[g.n] = g; });
  var picks = clean_(body.picks, byN);
  var started = function (n) { return Date.parse(byN[n].kickoff) <= now.getTime(); };
  var key = function (p) { return p.n + ':' + p.pick; };

  // Picks on games that already kicked off can't change: the ones already on file carry over
  // (the page counts them toward the 15), and new ones on those games are turned away.
  var prev = ((latestByName_(ss, st.week)[name] || {}).picks || []).filter(function (p) { return byN[p.n]; });
  var kept = prev.filter(function (p) { return started(p.n); });
  var before = kept.map(key);
  var added = picks.filter(function (p) { return started(p.n) && before.indexOf(key(p)) < 0; });
  if (added.length) {
    var ag = byN[added[0].n];
    throw userError_(ag.away.name + ' at ' + ag.home.name + ' already kicked off, so it can’t be picked or changed now.');
  }
  var isSide = function (p) { return p.pick === 'home' || p.pick === 'away' ? 0 : 1; };
  picks = picks.filter(function (p) { return !started(p.n); }).concat(kept)
    .sort(function (a, b) { return a.n - b.n || isSide(a) - isSide(b); });
  if (picks.length !== NEED) throw userError_('Pick exactly ' + NEED + '. You sent ' + picks.length + '.');
  picks.forEach(function (p) {
    var g = byN[p.n], side = p.pick === 'home' || p.pick === 'away';
    if (side && (g.homeLine == null || g.awayLine == null)) throw userError_(g.away.name + ' at ' + g.home.name + ' doesn’t have a spread yet.');
    if (!side && g.total == null) throw userError_(g.away.name + ' at ' + g.home.name + ' doesn’t have a total yet.');
  });

  var text = picks.map(function (p) { return formText_(byN[p.n], p.pick); }).join(', ');
  var labels = picks.map(function (p) { return label_(byN[p.n], p.pick); });
  var row = [now, name, text, JSON.stringify(picks)];
  if (body.dryRun) return { ok: true, dryRun: true, at: now.toISOString(), week: st.week, text: text, picks: labels };
  var sh = ss.getSheetByName(picksTab_(st.week)) || newPicksTab_(ss, st.week);
  sh.appendRow(row);
  return { ok: true, at: now.toISOString(), week: st.week, picks: labels };
}

function selftest_() {
  var ss = book_(), up = upcoming_(), g = up.games[0];
  var probe = ss.insertSheet('Self-test ' + Date.now());
  ss.deleteSheet(probe);
  return {
    ok: true, sheet: ss.getName(), players: players_(ss), upcomingWeek: up.week, opensAt: up.lockAt, linesFrom: up.source,
    games: up.games.length, sample: g ? [formText_(g, 'home'), formText_(g, 'over')] : [],
    linesTabs: lineWeeks_(ss), hourlyCheck: ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'hourly'; })
  };
}

/* ---------------- this week ---------------- */

/** open: a Lines tab with games still to kick off; otherwise upcoming (with when it opens). */
function state_(ss) {
  var weeks = lineWeeks_(ss), nowMs = Date.now();
  if (weeks.length) {
    var games = readLines_(ss, weeks[0]);
    if (games.some(function (g) { return Date.parse(g.kickoff) > nowMs; })) return { status: 'open', week: weeks[0], games: games };
  }
  var up = upcoming_();
  return { status: 'upcoming', week: up.week, opensAt: up.lockAt, games: [] };
}

/** The next week whose games haven't started, with the current lines and when they lock. */
function upcoming_() {
  var cache = CacheService.getScriptCache(), hit = cache.get('upcoming');
  if (hit) return JSON.parse(hit);
  var up;
  try {
    var sb = scoreboard_(null), week = (sb.week && sb.week.number) || 1, games = slate_(sb.events || []);
    if (!games.length || Date.parse(games[0].kickoff) <= Date.now()) {
      week += 1;
      games = slate_(scoreboard_(week).events || []);
    }
    up = { week: week, games: games, source: 'ESPN' };
  } catch (err) {
    console.warn(err.message + '; using the pick’em site’s copy');
    up = siteUpcoming_();
  }
  var out = { week: up.week, firstKickoff: up.games.length ? up.games[0].kickoff : null,
    lockAt: up.games.length ? lockAtFor_(up.games[0].kickoff) : null, games: up.games, source: up.source };
  cache.put('upcoming', JSON.stringify(out), 1800);
  return out;
}

/** The pick'em site's copy of the upcoming week, which its hourly update takes from ESPN. */
function siteUpcoming_() {
  var r = UrlFetchApp.fetch(SITE_DATA + '?t=' + Date.now(), { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('ESPN and the pick’em site both failed (the site answered ' + r.getResponseCode() + ')');
  var up = JSON.parse(r.getContentText()).upcoming;
  if (!up || !up.week || !up.games) throw new Error('The pick’em site has no upcoming week yet');
  return { week: up.week, games: up.games, source: 'site' };
}

/** A week's games with the latest lines, for locking: ESPN, or the site's copy if ESPN turns the script away. */
function weekGames_(week) {
  try {
    return slate_(scoreboard_(week).events || []);
  } catch (err) {
    var up = siteUpcoming_();
    if (up.week !== week) throw new Error(err.message + ', and the pick’em site has week ' + up.week + ', not ' + week);
    return up.games;
  }
}

/** 6 PM Central on the Wednesday before the week's first game (or 24 hours before it, if that's a Wednesday). */
function lockAtFor_(firstIso) {
  var first = new Date(firstIso);
  var dow = Number(Utilities.formatDate(first, TZ, 'u')) % 7;   // u: 1 = Monday ... 7 = Sunday
  var back = (dow - LOCK_WEEKDAY + 7) % 7;
  if (back === 0) return new Date(first.getTime() - 86400000).toISOString();
  var ymd = Utilities.formatDate(new Date(first.getTime() - back * 86400000), TZ, 'yyyy-MM-dd');
  var off = Utilities.formatDate(new Date(ymd + 'T12:00:00Z'), TZ, 'XXX');   // -05:00 or -06:00
  return new Date(ymd + 'T' + (LOCK_HOUR < 10 ? '0' : '') + LOCK_HOUR + ':00:00' + off).toISOString();
}

function scoreboard_(week) {
  var url = ESPN + (week ? '?seasontype=2&week=' + week + '&dates=' + SEASON : '');
  var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('ESPN answered ' + r.getResponseCode());
  return JSON.parse(r.getContentText());
}

function slate_(events) {
  return events.slice().sort(function (a, b) { return Date.parse(a.date) - Date.parse(b.date); }).map(function (ev, i) {
    var comp = ev.competitions[0], side = {};
    comp.competitors.forEach(function (c) { side[c.homeAway] = c; });
    var h = side.home.team, a = side.away.team, o = odds_(comp, h.abbreviation, a.abbreviation);
    return {
      n: i + 1, id: String(ev.id), kickoff: new Date(ev.date).toISOString(),
      home: { abbr: FIX[h.abbreviation] || h.abbreviation, name: h.shortDisplayName || h.abbreviation, logo: h.logo || '' },
      away: { abbr: FIX[a.abbreviation] || a.abbreviation, name: a.shortDisplayName || a.abbreviation, logo: a.logo || '' },
      homeLine: o.homeLine, awayLine: o.awayLine, total: o.total
    };
  });
}

/** ESPN's odds look like {details: "GB -7", overUnder: 45.5}; "EVEN" means a pick'em. */
function odds_(comp, home, away) {
  var o = (comp.odds || [])[0] || {};
  var out = { homeLine: null, awayLine: null, total: typeof o.overUnder === 'number' ? o.overUnder : null };
  var d = String(o.details || '').trim();
  if (/^(even|pk|pick)$/i.test(d)) { out.homeLine = 0; out.awayLine = 0; return out; }
  var m = d.match(/^([A-Z]{2,4})\s+([+-]?\d+(?:\.\d+)?)$/);
  if (m) {
    var x = Math.abs(parseFloat(m[2]));
    if (m[1] === home) { out.homeLine = -x; out.awayLine = x; }
    else if (m[1] === away) { out.awayLine = -x; out.homeLine = x; }
  }
  return out;
}

function writeLines_(ss, week, games) {
  var sh = ss.insertSheet(linesTab_(week));
  var blank = function (x) { return x == null ? '' : x; };
  var rows = games.map(function (g) {
    return [g.n, g.away.abbr, blank(g.awayLine), g.home.abbr, blank(g.homeLine), blank(g.total), new Date(g.kickoff),
      g.away.name, g.home.name, g.away.logo, g.home.logo, g.id];
  });
  sh.getRange(1, 1, 1, LINES_HEADER.length).setValues([LINES_HEADER]);
  if (rows.length) {
    sh.getRange(2, 1, rows.length, LINES_HEADER.length).setValues(rows);
    sh.getRange(2, 7, rows.length, 1).setNumberFormat('ddd m/d h:mm am/pm');
  }
  sh.setFrozenRows(1);
  sh.getRange(1, 1).setNote('Locked ' + fmt_(new Date(), 'EEE MMM d h:mm a') + ' CT from DraftKings via ESPN. ' +
    'Change any line or total here and the pick page uses it. Change both the away and home line together.');
  PropertiesService.getScriptProperties().setProperty('LOCKED_' + week, new Date().toISOString());
}

function readLines_(ss, week) {
  var sh = ss.getSheetByName(linesTab_(week));
  if (!sh) return [];
  var v = sh.getDataRange().getValues(), games = [];
  for (var i = 1; i < v.length; i++) {
    var r = v[i];
    if (r[0] === '' || r[0] == null) continue;
    var kick = r[6] instanceof Date ? r[6] : new Date(r[6]);
    var al = num_(r[2]), hl = num_(r[4]);
    if (al == null && hl != null) al = -hl;
    if (hl == null && al != null) hl = -al;
    games.push({
      n: Number(r[0]), id: String(r[11] || ''), kickoff: kick.toISOString(),
      away: { abbr: String(r[1]), name: String(r[7] || r[1]), logo: String(r[9] || '') },
      home: { abbr: String(r[3]), name: String(r[8] || r[3]), logo: String(r[10] || '') },
      awayLine: al, homeLine: hl, total: num_(r[5])
    });
  }
  return games;
}

function lineWeeks_(ss) {
  return ss.getSheets().map(function (s) { var m = s.getName().match(/^Lines Wk (\d+)$/); return m ? Number(m[1]) : 0; })
    .filter(function (w) { return w > 0; }).sort(function (a, b) { return b - a; });
}

/* ---------------- picks ---------------- */

function players_(ss) {
  var sh = ss.getSheetByName(PLAYERS_TAB);
  if (!sh) return DEFAULT_PLAYERS.slice();
  return sh.getDataRange().getValues().slice(1).map(function (r) { return String(r[0]).trim(); })
    .filter(function (n) { return n; });
}

function latestByName_(ss, week) {
  var sh = ss.getSheetByName(picksTab_(week)), out = {};
  if (!sh) return out;
  var v = sh.getDataRange().getValues();
  for (var i = 1; i < v.length; i++) {
    var name = String(v[i][1]).trim();
    if (!name) continue;
    var at = v[i][0] instanceof Date ? v[i][0] : new Date(v[i][0]), picks = [];
    try { picks = JSON.parse(v[i][3] || '[]'); } catch (ignore) {}
    if (!out[name] || at.getTime() >= out[name].at.getTime()) out[name] = { at: at, picks: picks };
  }
  return out;
}

/** How many of each player's picks are on games that already kicked off (they carry over). */
function carried_(ss, week, games) {
  var nowMs = Date.now(), started = {}, out = {}, latest = latestByName_(ss, week);
  games.forEach(function (g) { if (Date.parse(g.kickoff) <= nowMs) started[g.n] = true; });
  Object.keys(latest).forEach(function (name) {
    var n = (latest[name].picks || []).filter(function (p) { return started[p.n]; }).length;
    if (n) out[name] = n;
  });
  return out;
}

function submitted_(ss, week) {
  var latest = latestByName_(ss, week);
  return Object.keys(latest).map(function (n) { return { name: n, at: latest[n].at.toISOString() }; });
}

function clean_(list, byN) {
  if (!Array.isArray(list)) throw userError_('No picks came through. Try again.');
  var seen = {}, out = [];
  list.forEach(function (p) {
    var n = Number(p && p.n), pick = String(p && p.pick), g = byN[n];
    if (!g) throw userError_('One of those games isn’t on this week’s sheet. Reload the page and pick again.');
    if (['home', 'away', 'over', 'under'].indexOf(pick) < 0) throw userError_('One pick didn’t come through right. Reload the page and pick again.');
    var kind = pick === 'home' || pick === 'away' ? 'side' : 'total';
    if (seen[n + kind]) throw userError_('Pick one ' + kind + ' at most for ' + g.away.name + ' at ' + g.home.name + '.');
    seen[n + kind] = true;
    out.push({ n: n, pick: pick });
  });
  var isSide = function (p) { return p.pick === 'home' || p.pick === 'away' ? 0 : 1; };
  return out.sort(function (a, b) { return a.n - b.n || isSide(a) - isSide(b); });
}

/** Same text the old Google Form produced, e.g. "G3 | Bears (away) -1.5 | Sun 12:00pm CT". */
function formText_(g, pick) {
  var slot = fmt_(g.kickoff, 'EEE h:mma').replace('AM', 'am').replace('PM', 'pm') + ' CT';
  if (pick === 'over' || pick === 'under') return 'G' + g.n + ' | ' + (pick === 'over' ? 'Over ' : 'Under ') + g.total + ' | ' + slot;
  var line = pick === 'home' ? g.homeLine : g.awayLine;
  return 'G' + g.n + ' | ' + g[pick].name + ' (' + pick + ') ' + (line === 0 ? 'PK' : (line > 0 ? '+' : '') + line) + ' | ' + slot;
}

function label_(g, pick) {
  if (pick === 'over' || pick === 'under') return (pick === 'over' ? 'Over ' : 'Under ') + g.total + ' (' + g.away.abbr + '–' + g.home.abbr + ')';
  var line = pick === 'home' ? g.homeLine : g.awayLine;
  return g[pick].name + ' ' + (line === 0 ? 'PK' : (line > 0 ? '+' : '−') + Math.abs(line));
}

function newPicksTab_(ss, week) {
  var sh = ss.insertSheet(picksTab_(week));
  sh.getRange(1, 1, 1, PICKS_HEADER.length).setValues([PICKS_HEADER]);
  sh.setFrozenRows(1);
  return sh;
}

/* ---------------- helpers ---------------- */

function book_() {
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : (SpreadsheetApp.getActive() || SpreadsheetApp.openById(PICK_SHEET_ID));
}
function num_(x) {
  if (x === '' || x == null) return null;
  if (/^(pk|even)$/i.test(String(x).trim())) return 0;
  var n = Number(x);
  return isNaN(n) ? null : n;
}
function fmt_(d, pattern) { return Utilities.formatDate(d instanceof Date ? d : new Date(d), TZ, pattern); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function userError_(msg) { var e = new Error(msg); e.user = true; return e; }
