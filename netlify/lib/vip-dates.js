// Event dates for the VIP features, shared by netlify/functions/volunteer-scan.js
// (the not-today check at /scan) and netlify/functions/telegram-webhook.js
// (which events /vips lists). Kept outside netlify/functions so Netlify does not
// deploy it as a function of its own; the functions require it and it is
// bundled with them.
//
// Event dates come from a date column ("2026-11-08") or, on older rows, from
// free text typed in the admin portal ("Sat, Nov 7, 2026", "11/7/2026", a range
// in one field, an end date without a year). Anything that can't be read with
// confidence is "can't tell" (null), which never blocks a check-in.

const TZ = 'America/New_York';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function ymd(y, mo, d) {
  if (!(y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Every date found in a piece of text, in order. A "Month D" with no year
// takes yearHint (an end date typed as "Sun, Nov 8" after a start of
// "Sat, Nov 7, 2026").
const DATE_RE = /(\d{4})-(\d{1,2})-(\d{1,2})|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?(?![\d:])|\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/gi;
function datesIn(v, yearHint) {
  const out = [];
  for (const m of String(v == null ? '' : v).matchAll(DATE_RE)) {
    let d = null;
    if (m[1]) d = ymd(+m[1], +m[2], +m[3]);
    else if (m[4]) d = (m[6] || yearHint) ? ymd(+(m[6] || yearHint), MONTHS.indexOf(m[4].toLowerCase()) + 1, +m[5]) : null;
    else if (m[7]) d = ymd(+m[9], +m[7], +m[8]);
    if (d) out.push(d);
  }
  return out;
}

const todayYmd = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });   // "YYYY-MM-DD"

// The event's first and last day ({ start, end } as "YYYY-MM-DD"), or null
// when the dates can't be read with confidence. A range like
// "Nov 7 - 8, 2026" that can't be fully read means "can't tell".
function eventWindow(evt) {
  if (!evt) return null;
  const startText = String(evt.start_date == null ? '' : evt.start_date).trim();
  const endText = String(evt.end_date == null ? '' : evt.end_date).trim();
  const first = datesIn(startText);
  if (!first.length) return null;
  const year = +first[0].slice(0, 4);
  const starts = datesIn(startText, year);
  // "Nov 7 – 8, 2026" (ISO dates aside, whose own dashes don't count)
  if (/\d\s*[-–—]\s*\d/.test(startText.replace(/\d{4}-\d{1,2}-\d{1,2}/g, '')) && starts.length < 2) return null;
  let ends = endText ? datesIn(endText, year) : [];
  if (endText && !ends.length) return null;                                    // an end we can't read
  // "Dec 31, 2026" to "Jan 1" (no year): the end is in the next year.
  ends = ends.map((d) => (d < starts[0] ? datesIn(endText, year + 1)[0] || d : d));
  const all = [...starts, ...ends].sort();
  return { start: all[0], end: all[all.length - 1] };
}

// True only when the event's dates are known and today (New York) is outside them.
function notToday(evt) {
  const w = eventWindow(evt);
  if (!w) return false;
  const today = todayYmd();
  return today < w.start || today > w.end;
}

// "11 am" / "11:00am" -> "11:00 AM"; anything else as typed.
function formatTime(raw) {
  const t = String(raw || '').trim();
  const m = t.match(/^(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?\s*m\.?$/i);
  if (!m || +m[1] < 1 || +m[1] > 12 || (m[2] && +m[2] > 59)) return t;
  return (+m[1]) + ':' + (m[2] || '00') + ' ' + m[3].toUpperCase() + 'M';
}

module.exports = { TZ, datesIn, eventWindow, notToday, todayYmd, formatTime };
