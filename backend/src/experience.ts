import { Job } from './types';

// Seniority / years-of-experience detection. Job data rarely has a clean "years
// required" field, so we infer it from the title and description. Used to
// down-rank roles that need more experience than the candidate targets.

const SENIOR_TITLE =
  /\b(senior|sr\.?|lead|principal|staff|architect|manager|director|head\s+of|vp|vice\s+president|expert)\b/i;

const JUNIOR_TITLE =
  /\b(junior|jr\.?|associate|entry[-\s]?level|graduate|grad|intern|internship|trainee|fresher)\b/i;

// Lowest "years required" mentioned in the text (the floor of a range), or null.
// Matches "5+ years", "5-7 years", "minimum 5 years", "5 yrs".
function minYearsRequired(text: string): number | null {
  const re = /(\d{1,2})\s*(?:\+|-\s*\d{1,2})?\s*\+?\s*(?:years?|yrs?)\b/gi;
  let min: number | null = null;
  for (const m of text.matchAll(re)) {
    const n = Number(m[1]);
    if (!Number.isNaN(n) && n >= 0 && n <= 25) {
      min = min === null ? n : Math.min(min, n);
    }
  }
  return min;
}

export interface SeniorityCheck {
  tooSenior: boolean;
  note: string; // short human-readable reason, empty if fine
}

export function checkSeniority(job: Job, maxYoE: number | null): SeniorityCheck {
  const title = job.title || '';
  const desc = job.description || '';

  // An explicit junior signal in the title always wins.
  if (JUNIOR_TITLE.test(title)) return { tooSenior: false, note: '' };

  const cap = maxYoE ?? 3;

  if (SENIOR_TITLE.test(title)) {
    return { tooSenior: true, note: 'senior-level title' };
  }

  const years = minYearsRequired(desc);
  if (years !== null && years > cap) {
    return { tooSenior: true, note: `needs ~${years}+ yrs (above your ${cap})` };
  }

  return { tooSenior: false, note: '' };
}
