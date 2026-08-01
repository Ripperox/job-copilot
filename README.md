# Job Copilot

A local, human-in-the-loop job-search assistant. It finds jobs relevant to your
resume, scores each one against your profile, and shows you the strong matches —
so you spend your time applying to the right roles instead of finding them.

**You stay the "send" button.** It finds and scores (and later, drafts outreach);
you review and apply. That keeps quality high and keeps you off the wrong side of
any platform's automation rules.

## What it does

1. You set your **profile** once — resume text + roles, locations, salary floor,
   must-haves, and your CV variants (e.g. Backend / AI / Blockchain).
2. Click **Fetch** — it pulls jobs from configured sources.
3. Each new job is **scored 0–100** against your profile, with a one-line reason
   and a pick of **which CV variant** to use.
4. The **dashboard** shows matches best-first; filter to 80%+ and mark what you've
   applied to.
5. For any match, **draft outreach** — a personalized referral/feedback message, an
   application note, and who to contact (pre-filled LinkedIn people-search links) —
   which you review, tweak, and send yourself.
6. **Track each job through a pipeline** — New → Outreach → Applied → Interview →
   Rejected — with per-job **notes** and a **dismiss** to hide the irrelevant ones.
   Your application tracker lives inside the tool.

> Tip: after adding an Anthropic key or editing your profile, hit **Re-score** to
> re-rank jobs you already fetched (a plain fetch only scores brand-new ones).

Runs entirely on your machine. No server, no VM. Your resume never leaves your box.

## Architecture

- **backend/** — Node.js + TypeScript (Express), run with `tsx`. A JSON-file store
  (swappable for SQLite later). Job sources + LLM/heuristic scoring.
- **frontend/** — React + TypeScript (Vite) dashboard.

```
Job sources ──► store ──► scorer (LLM or heuristic) ──► dashboard (80%+ matches)
```

### Job sources
- **Sample jobs** (built in — works with zero setup)
- **Adzuna** (free API key) — broad India/remote search
- **Greenhouse / Lever** public boards (no key) — point them at specific companies

### Scoring
- **With an Anthropic API key:** an LLM scores each job against your full resume.
- **Without a key:** a keyword heuristic (cruder, but free and instant).

## Run it

**Backend** (terminal 1):
```bash
cd backend
cp .env.example .env      # optional — add keys for real jobs + LLM scoring
npm install
npm run dev               # http://localhost:4500
```

**Frontend** (terminal 2):
```bash
cd frontend
npm install
npm run dev               # opens the dashboard
```

With no keys it runs on sample jobs + heuristic scoring, so you can try the whole
flow immediately. Add keys in `backend/.env` to get real jobs and smarter scoring.

## Configuration (`backend/.env`, all optional)

| Key | What it enables |
|-----|-----------------|
| `ANTHROPIC_API_KEY` | LLM scoring instead of the keyword heuristic |
| `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` | Real job search via Adzuna (free tier) |
| `GREENHOUSE_BOARDS` | Comma-separated board tokens (e.g. `stripe,ramp`) |
| `LEVER_BOARDS` | Comma-separated company slugs |

## Roadmap

- **Next (optional):** deploy to a cheap always-on host so it fetches new matches
  every morning and emails you; add reply/response tracking on top of the
  applied/outreach state.

## Why human-in-the-loop

Automating the *search and drafting* removes ~80% of the daily grind. Automating the
*sending* (auto-apply, auto-DM on LinkedIn) saves little and risks a lot — account
bans and low-quality spam that hurts your reply rate. So this tool does the tedious
part and leaves the judgment to you.
