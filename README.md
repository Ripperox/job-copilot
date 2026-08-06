# Shortlist

A human-in-the-loop job-search cockpit. It pulls roles from five job sources,
scores every one against your résumé with an LLM (plus a hard experience filter),
drafts personalized referral outreach, and tracks each application through a
pipeline — so your time goes to *applying to the right roles*, not finding them.

> **You stay the "send" button.** It finds, scores, and drafts; you review and
> send. That's deliberate — automating the *sending* (LinkedIn scraping, auto-apply
> bots) gets accounts banned and floods recruiters with low-quality spam. Automating
> the *research and drafting* removes ~80% of the daily grind and keeps quality high.

## Features

- **5 job sources, one pipeline** — Adzuna, JSearch (Google-for-Jobs → LinkedIn/Indeed/Glassdoor),
  Jooble, Active Jobs DB (200k+ career sites/ATS), and LinkedIn Job Search. Normalized to
  one schema and de-duplicated. Falls back to a built-in sample set with zero keys.
- **LLM relevance scoring** — each job scored 0–100 against your full résumé, with a
  one-line reason and a pick of *which CV variant* to send. Provider-agnostic:
  **Groq** (free/fast) → **Anthropic** → a keyword **heuristic** if no key is set.
- **Experience filter** — the core product insight: a junior can't get a senior role.
  Seniority is detected from titles (*Senior / Lead / Principal*) and "N+ years" in the
  description, and hard-gated below your target — so senior roles never clutter your list.
- **Outreach drafting** — for any match, a personalized referral message + application
  note + who to contact (pre-filled LinkedIn people-searches), all editable and copy-ready.
- **Pipeline tracker** — move each job New → Outreach → Applied → Interview → Rejected,
  with per-job notes and dismiss. Your application tracker lives inside the tool.

## Architecture

```
 5 job sources ─┐
 (normalize +   ├─► JSON store ─► scorer ─► dashboard
  de-dupe)      │                  │          (pipeline · outreach · filters)
                │        ┌─────────┴─────────┐
                │        │ 1. experience gate │  senior?  → skip LLM, cap low
                │        │ 2. eng-title gate  │  non-eng? → skip LLM
                │        │ 3. LLM score       │  Groq / Anthropic / heuristic
                │        └────────────────────┘
```

- **backend/** — Node.js + TypeScript (Express), run via `tsx`. Pluggable job sources,
  a provider-agnostic LLM layer, and a JSON-file store (abstracted for an easy swap to
  SQLite/Postgres).
- **frontend/** — React + TypeScript (Vite). Dark, terminal-inspired dashboard.

### The scoring pipeline (why it scales)

A naive "LLM-score every job" approach dies when you pull 500+ jobs across five
sources — hundreds of API calls, rate limits, minutes of waiting. Instead, two cheap
gates run first:

1. **Experience gate** — senior/lead/principal roles (or "5+ years") are capped low
   *without* an LLM call. A junior isn't applying to them anyway.
2. **Engineering-title gate** — sales/marketing/support roles from big company boards
   are skipped cheaply.

Only the promising, right-level jobs reach the LLM. Result: **~500 jobs from 5
sources scored in ~40s**, gracefully falling back to the heuristic per-job if the LLM
errors or rate-limits.

## Run it

**Backend** (terminal 1):
```bash
cd backend
cp .env.example .env      # optional — add keys for real jobs + LLM scoring
npm install
npm run seed              # seeds a starter profile (edit later in the UI)
npm run dev               # http://localhost:4500
```

**Frontend** (terminal 2):
```bash
cd frontend
npm install
npm run dev               # http://localhost:5173
```

With **no keys** it runs on the built-in sample jobs + heuristic scoring, so you can
try the whole flow immediately.

## Configuration (`backend/.env`, all optional)

| Key | Enables |
|-----|---------|
| `GROQ_API_KEY` | Free, fast LLM scoring + outreach (recommended) |
| `ANTHROPIC_API_KEY` | LLM via Anthropic (used only if Groq isn't set) |
| `JSEARCH_RAPIDAPI_KEY` | JSearch + Active Jobs DB + LinkedIn (shared RapidAPI key) |
| `JOOBLE_API_KEY` | Jooble aggregator (India depth) |
| `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` | Adzuna search |

## Deploy (optional public demo)

The frontend reads `VITE_API_URL`, so it's deploy-ready:
- **Frontend → Vercel** (set `VITE_API_URL=https://<your-backend>/api`).
- **Backend → Render / Railway / Fly** (`npm start`).

Deploy **without job-source keys** for a safe public demo — it runs on sample data, so
visitors can click the real UI without touching your API quotas or personal profile.

## Tests

```bash
cd backend && npm test    # (if present) integration coverage of routes + scoring
```

## Tech

TypeScript · Node.js · Express · React · Vite · Groq / Anthropic · RapidAPI

## Why this design

Every layer degrades gracefully: no keys → samples + heuristic + template outreach;
a dead source or a failed LLM call is caught and skipped, never crashing a fetch. The
hard part of a job search isn't clicking apply — it's finding the *right* roles and
writing something worth reading. This automates exactly that, and leaves the judgment
(and the send button) to you.
