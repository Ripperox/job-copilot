# Shortlist — Multi-tenant SaaS design

**Date:** 2026-08-03
**Status:** approved. **Phase 1 (Postgres migration) — SHIPPED 2026-08-03** on branch
`saas-phase1-postgres` (30 tests passing; 409 jobs / 409 scores / 6 pipeline entries
migrated from `store.json` and verified against a backup). Phases 2–5 pending.

One refinement adopted during Phase 1: the `users` table and `user_id` columns were
created up front and every `db` call site threads a fixed `LOCAL_USER_ID`, so Phase 3
is parameter plumbing (constant → session) rather than a schema and query rewrite.
**Scope:** turn the single-user local Shortlist into a hosted, multi-tenant web app with Google login and bring-your-own-key (BYOK) LLM scoring.

---

## 1. Context — where the app is today

Shortlist currently runs as a local, single-user tool:

- **backend/** — Express + TypeScript (run via `tsx`), a JSON-file store (`backend/data/store.json`) behind a `db` module, pluggable job sources (Adzuna, JSearch, Jooble, Active Jobs DB, LinkedIn, Greenhouse, Lever, mock), a provider-agnostic LLM layer (Gemini → Groq → Anthropic → heuristic), and an hourly auto-fetch scheduler.
- **frontend/** — React + Vite dashboard reading `VITE_API_URL` (default `http://localhost:4500/api`).
- **No authentication.** Exactly one implicit user; one `profile` row; every job score and pipeline entry is global.

Two constraints discovered while operating it, which shape this design:

1. **Job-source quotas are per-account and small.** Active Jobs DB and LinkedIn (RapidAPI) are already exhausted on the free plan; JSearch is flaky; Adzuna and Jooble work. Free tiers generally prohibit redistribution/commercial multi-user use.
2. **LLM scoring is the dominant per-user cost.** Each score sends résumé + job description (~3k tokens). Groq's free tier (~100k tokens/day on 70B) could not sustain even one user's hourly inflow; Gemini's free tier (~1M TPM, ~1500 req/day) can.

## 2. Goals and non-goals

**Goals**

- Anyone can sign up with Google and get their own private profile, scores, and application pipeline.
- A new user sees the product work immediately, before providing any key.
- Operating cost stays effectively flat as users are added.
- Stay within third-party API terms (no reselling free-tier job data or LLM access).
- Per-user data is isolated, and users' stored credentials are encrypted.

**Non-goals (explicitly out of scope for this version)**

- Billing, payments, paid plans, or usage metering.
- Email/password auth, magic links, or any non-Google identity provider.
- Team/organization accounts or sharing between users.
- Automating job *applications* (the product deliberately keeps the human as the "send" button).
- Mobile apps; a responsive web UI is sufficient.

## 3. Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Tenancy | Multi-tenant, per-user data | Product goal. |
| Cost model | Freemium: 1 demo job on operator keys; full pool via user's own Gemini key (BYOK) | Flat operator cost; avoids free-tier quota walls and redistribution terms. |
| Auth | Google OAuth 2.0 only | One click; no password storage, hashing, reset flows, or breach surface. |
| Stack | Keep Express + React; replace JSON store with Postgres | Smallest throwaway; the multi-tenant schema, isolation, and scheduler remain first-party work. |
| Job pool | **Shared** across all users; fetched once by a central scheduler on operator keys | Listings are not user-specific. Spends job-source quota once, not per user. |
| Scoring | **Per-user**, on the user's own key | Scoring is résumé-dependent and is the expensive part. |
| Hosting | Frontend → Vercel; backend → Render/Fly; Postgres → Neon | Free/cheap tiers; backend needs a long-lived process for the scheduler. |

## 4. Architecture

```
                        ┌───────────────────────────────┐
  operator keys ──────► │ central scheduler (hourly)     │
  (Adzuna, Jooble, …)   │ gatherJobs() → shared `jobs`   │
                        └───────────────┬───────────────┘
                                        │ (one shared pool)
                                        ▼
  Google ──► /api/auth ──► session cookie ──► Express API ──► Postgres
                                        │                      ├── shared: jobs
                                        │                      └── per-user: profiles,
                                        │                          user_keys, scores,
                                        │                          job_meta, outreach
                                        ▼
                      per-user scoring with the user's own Gemini key
                      (experience gate → title gate → LLM), or the
                      1-job cached demo when no key is present
```

The `db` module keeps its role as the storage seam: it is reimplemented against Postgres (via `pg` with a connection pool), and every per-user method takes a `userId` as its first argument. Callers (`server.ts`) pass `req.userId` from the session — never a client-supplied value.

## 5. Data model

**Shared tables**

- `jobs` — `id` TEXT PK (e.g. `adzuna:12345`), `source`, `title`, `company`, `location`, `description`, `url`, `salary`, `posted_at`, `created_at`.
- `demo_score` — a single cached, pre-scored example (job_id + score + reason + cv_variant) shown to users without a key. Generated once by a seed/admin task on operator keys.

**Per-user tables** (every row keyed by `user_id`)

- `users` — `id` UUID PK, `google_sub` TEXT UNIQUE, `email`, `name`, `created_at`.
- `profiles` — `user_id` PK/FK, `resume_text`, `roles` TEXT[], `locations` TEXT[], `salary_floor_lpa`, `max_yoe`, `must_haves` TEXT[], `cv_variants` TEXT[].
- `user_keys` — `user_id` PK/FK, `gemini_key_encrypted` BYTEA/TEXT, `updated_at`. (Optional per-user job-source keys may be added later; not required for v1.)
- `scores` — PK `(user_id, job_id)`, `score` INT, `reason` TEXT, `cv_variant` TEXT, `scored_at`.
- `job_meta` — PK `(user_id, job_id)`, `status` TEXT, `notes` TEXT, `dismissed` BOOL. (The pipeline.)
- `outreach` — PK `(user_id, job_id)`, `referral_message`, `application_note`, `targets` JSONB, `cv_variant`, `generated_at`.

All per-user tables use `ON DELETE CASCADE` from `users` so account deletion removes everything.

Indexes: `scores(user_id, score DESC)` for the sorted dashboard query; `job_meta(user_id, status)` for pipeline views; `jobs(created_at DESC)`.

## 6. Authentication

Google OAuth 2.0 authorization-code flow, verified server-side.

- `GET /api/auth/google` — redirect to Google's consent screen (state parameter for CSRF).
- `GET /api/auth/google/callback` — exchange the code, **verify the Google ID token server-side** (signature, `aud`, `iss`, expiry), upsert a `users` row by `google_sub`, then set a signed **httpOnly, Secure, SameSite=Lax** session cookie (JWT signed with `SESSION_SECRET`).
- `GET /api/auth/me` — current user (`{ id, email, name, hasKey }`) or 401.
- `POST /api/auth/logout` — clear the cookie.
- `DELETE /api/auth/account` — delete the user and all their data (cascade).

A `requireAuth` middleware verifies the cookie, sets `req.userId`, and guards **every** `/api` route except `/api/health`, `/api/demo`, and the auth routes themselves.

## 7. Freemium / demo gate

| User state | What they get |
|---|---|
| Logged out | Landing page + `GET /api/demo`: one pre-scored example job. |
| Logged in, no Gemini key | Dashboard shell + the same single demo job + prompt to add a key (with a link to Google AI Studio). |
| Logged in, key saved | Full shared job pool scored against their résumé on their own quota, plus pipeline and outreach. |

The demo response is a **cached, static, pre-scored row** — identical for every visitor and computed once. Operator LLM cost therefore does not scale with signups, and there is no abuse vector.

## 8. Job fetching vs. scoring

- **Fetching (app-wide, operator keys).** The existing scheduler keeps running on the server, hourly (`FETCH_INTERVAL_MINUTES`), writing into the shared `jobs` table. It is **not** per-user and is not triggered by user actions.
- **Scoring (per-user, BYOK).** `POST /api/score` (authed) scores that user's unscored jobs: cheap **experience gate** and **title gate** first (no LLM call), then the LLM using the user's decrypted key. Triggered automatically after the user saves a profile or a key, and available as a manual "rescore" action.
  - Work is **batched and capped per request** (e.g. N jobs per invocation, with the client able to continue) so a single user cannot blow through their own rate limit in one burst.
  - If the user's key fails (401/429), scoring degrades to the existing keyword heuristic and the API returns a clear `keyError` flag; the UI shows a banner. It must never return a 500 for a bad user key.

## 9. Security and privacy

Because the app now stores other people's résumés and API keys:

- **BYOK keys encrypted at rest** with AES-256-GCM using a server-held `KEY_ENCRYPTION_SECRET`; decrypted only in memory at call time; never logged; **never returned to the client** (the API exposes only `hasKey: boolean`).
- **Tenant scoping** comes exclusively from the session (`req.userId`); no endpoint accepts a `user_id` from the request body or query.
- Cookies: httpOnly, Secure, SameSite=Lax. CORS restricted to the deployed frontend origin (no wildcard).
- Rate limiting on auth and scoring endpoints.
- **Account deletion** removes profile, scores, pipeline, outreach, and stored key — a baseline DPDP/GDPR-friendly posture, since résumé text is personal data.
- Secrets (`DATABASE_URL`, Google client secret, `SESSION_SECRET`, `KEY_ENCRYPTION_SECRET`, operator job-source keys) live in host env vars, never in the repo. `.env` remains gitignored.

## 10. Error handling

- Per-source fetch failures are already caught per source and skipped; the scheduler additionally must never crash the process (all errors caught and logged).
- Per-user key failures degrade to heuristic scoring with a surfaced flag (see §8).
- DB errors return 500 with a generic message; details logged server-side only.
- The existing single-flight `fetching` lock is retained so scheduled and manual fetches cannot overlap.

## 11. Testing

The project currently has no tests. Add a minimal **Vitest** setup with a test Postgres database. Priority order:

1. **Tenant isolation (highest priority).** User A cannot read or mutate user B's scores, pipeline, outreach, profile, or key — asserted per endpoint.
2. **Key encryption round-trip**, and the assertion that no API response body ever contains a raw key.
3. **Demo endpoint** returns exactly one job and requires no auth.
4. **Scoring gates** — senior roles are capped without an LLM call; non-engineering titles skip the LLM.
5. **Auth middleware** — unauthenticated requests to guarded routes return 401.

## 12. Hosting and configuration

- **Frontend → Vercel**, `VITE_API_URL` pointing at the backend's `/api`.
- **Backend → Render or Fly** (needs a long-lived process for the scheduler; serverless would not keep it alive).
- **Postgres → Neon.**

Environment variables: `DATABASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OAUTH_REDIRECT_URL`, `SESSION_SECRET`, `KEY_ENCRYPTION_SECRET`, `FRONTEND_ORIGIN`, `FETCH_INTERVAL_MINUTES`, plus operator job-source keys (`ADZUNA_*`, `JOOBLE_API_KEY`, `JSEARCH_RAPIDAPI_KEY`).

## 13. Build order

Each phase is independently shippable and testable; work can stop after any phase and still leave a working app.

1. **Postgres migration** — replace the JSON store with Postgres behind the existing `db` interface, still single-user. Prove nothing broke (existing endpoints behave identically; existing `store.json` data migrated).
2. **Auth** — `users` table, Google OAuth routes, session cookie, `requireAuth` middleware, frontend login screen.
3. **Multi-tenancy** — add `user_id` to per-user tables and thread it through `db` and `server.ts`; write the isolation tests.
4. **BYOK + demo gate** — `user_keys` with encryption, settings UI, per-user scoring path, cached 1-job demo, key-failure handling.
5. **Deploy** — Neon + Render/Fly + Vercel, environment wiring, Google OAuth redirect URIs for the production domain.

## 14. Open items (to resolve during implementation, not blockers)

- Exact per-request scoring batch size (tune against Gemini's rate limits once measured).
- Whether to let users optionally supply their own job-source keys (deferred; the shared pool suffices for v1).
- Landing/marketing copy for the logged-out page.
