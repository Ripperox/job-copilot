/**
 * Salary strings arrive from the job sources in whatever shape the board used:
 *
 *   "1500000–2000000"            (bare INR/year — the common Indian case)
 *   "700000–1100000 INR YEAR"
 *   "30–130 USD HOUR"
 *
 * Rendering those raw puts "1500000-2000000" on screen, which nobody reads as
 * money. This turns them into what an Indian job-seeker actually says out loud:
 * "₹15–20 LPA".
 *
 * Anything we cannot confidently parse is returned unchanged — a slightly ugly
 * true string beats a confidently wrong pretty one.
 */

// Handles the en-dash sources like to use, as well as a plain hyphen or "to".
const RANGE = /^\s*([\d,.]+)\s*(?:[–—-]|to)\s*([\d,.]+)\s*(.*)$/i;
const SINGLE = /^\s*([\d,.]+)\s*(.*)$/;

const LAKH = 100_000;

function num(s: string): number | null {
  const n = Number(s.replace(/[, ]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// 15 -> "15", 15.5 -> "15.5" (never "15.0")
const trim = (n: number): string => String(Math.round(n * 10) / 10);

export function formatSalary(raw: string | null | undefined): string {
  if (!raw) return '';
  const value = raw.trim();
  if (!value) return '';

  const range = value.match(RANGE);
  const single = range ? null : value.match(SINGLE);
  const suffix = ((range?.[3] ?? single?.[2]) || '').trim().toUpperCase();

  // Only reformat when the figure is annual rupees. An hourly USD rate is
  // already readable and converting it would be inventing information.
  const perHour = /HOUR|HR|HOURLY/.test(suffix);
  const nonINR = /USD|EUR|GBP|\$|€|£/.test(suffix);
  if (perHour || nonINR) return value;

  const lo = num(range?.[1] ?? single?.[1] ?? '');
  if (lo == null) return value;
  const hi = range ? num(range[2]) : null;

  // Below a lakh this is not an annual Indian salary — probably monthly, or a
  // figure already expressed in lakhs. Leave it alone.
  if (lo < LAKH) return value;

  const loL = trim(lo / LAKH);
  if (hi == null || hi <= lo) return `₹${loL} LPA`;
  return `₹${loL}–${trim(hi / LAKH)} LPA`;
}

/** "2026-08-01" -> "2 days ago" / "3 weeks ago". Empty when unknown. */
export function formatPosted(raw: string | null | undefined): string {
  if (!raw) return '';
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return '';
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days < 0) return '';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'last week';
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}
