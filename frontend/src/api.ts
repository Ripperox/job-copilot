// Point at a deployed backend with VITE_API_URL (e.g. https://job-copilot.onrender.com/api);
// falls back to the local backend in dev.
export const API =
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ||
  'http://localhost:4500/api'

export interface Profile {
  resumeText: string
  roles: string[]
  locations: string[]
  salaryFloorLPA: number | null
  maxYoE: number | null
  mustHaves: string[]
  cvVariants: string[]
}

export type JobStatus = 'new' | 'outreach' | 'applied' | 'interview' | 'rejected'

export const JOB_STATUSES: JobStatus[] = [
  'new',
  'outreach',
  'applied',
  'interview',
  'rejected',
]

export interface ScoredJob {
  id: string
  source: string
  title: string
  company: string
  location: string
  description: string
  url: string
  salary: string | null
  postedAt: string | null
  createdAt: string
  score: number | null
  reason: string | null
  cvVariant: string | null
  status: JobStatus
  notes: string
  dismissed: boolean
}

export interface OutreachTarget {
  title: string
  searchUrl: string
}

export interface Outreach {
  jobId: string
  referralMessage: string
  applicationNote: string
  targets: OutreachTarget[]
  cvVariant: string
  generatedAt: string
}

export interface Health {
  status: string
  llm: 'gemini' | 'groq' | 'anthropic' | 'heuristic'
  adzuna: boolean
  auth: boolean
}

export interface User {
  id: string
  email: string
  name: string
}

// Thrown on a 401 so callers can show the sign-in screen instead of an error.
export class UnauthorizedError extends Error {
  constructor() {
    super('Not signed in.')
    this.name = 'UnauthorizedError'
  }
}

export interface FetchResult {
  sources: string[]
  scored: number
  total: number
}

export interface RescoreResult {
  rescored: number
}

// In-flight request de-duplication.
//
// Mounting the app fired four requests where two would do: the landing-tab
// check asks for jobs, then the dashboard it lands on asks for the same jobs
// again, and both ask for sources. Identical concurrent GETs now share one
// response instead of racing each other to the same rows — which matters a
// lot here because /jobs is a join over the whole pool.
//
// Deliberately only in-flight, with no TTL: a stale cache after a fetch or a
// status change would be a correctness bug, and this collapses the duplicates
// without pretending to know when data went out of date.
const inFlight = new Map<string, Promise<unknown>>()

function dedupe<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key)
  if (existing) return existing as Promise<T>
  const p = run().finally(() => inFlight.delete(key))
  inFlight.set(key, p)
  return p as Promise<T>
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Only GETs are shared; a POST or PATCH must always be sent.
  const method = (init?.method ?? 'GET').toUpperCase()
  if (method === 'GET') return dedupe(path, () => rawRequest<T>(path, init))
  return rawRequest<T>(path, init)
}

/** Like request(), but also hands back the response headers (x-total-count). */
async function requestWithHeaders<T>(
  path: string,
): Promise<{ data: T; headers: Headers }> {
  return dedupe(`H:${path}`, async () => {
    const res = await fetch(`${API}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    })
    if (res.status === 401) throw new UnauthorizedError()
    if (!res.ok) {
      let detail = ''
      try {
        detail = await res.text()
      } catch {
        detail = ''
      }
      throw new Error(`Request failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`)
    }
    const text = await res.text()
    return { data: (text ? JSON.parse(text) : null) as T, headers: res.headers }
  })
}

async function rawRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    // Sends and accepts the session cookie on cross-origin dev requests.
    credentials: 'include',
    ...init,
  })
  if (res.status === 401) throw new UnauthorizedError()
  if (!res.ok) {
    let detail = ''
    try {
      detail = await res.text()
    } catch {
      detail = ''
    }
    throw new Error(
      `Request failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    )
  }
  // Some endpoints may legitimately return an empty body.
  const text = await res.text()
  return (text ? JSON.parse(text) : null) as T
}

export function getHealth(): Promise<Health> {
  return request<Health>('/health')
}

// ---- auth ----

// Resolves to the signed-in user, or null when signed out.
export async function getMe(): Promise<User | null> {
  try {
    return await request<User>('/auth/me')
  } catch (e) {
    if (e instanceof UnauthorizedError) return null
    throw e
  }
}

// Full-page redirect: the OAuth consent screen cannot run in fetch(). We pass our
// own origin so the backend knows where to return us (the dev port varies); it
// only honours origins on its allowlist.
export function startGoogleLogin(): void {
  const back = encodeURIComponent(window.location.origin)
  window.location.href = `${API}/auth/google?return=${back}`
}

export function logout(): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/auth/logout', { method: 'POST' })
}

export function deleteAccount(): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/auth/account', { method: 'DELETE' })
}

// ---- bring-your-own-key ----

export interface KeyStatus {
  hasKey: boolean
  // A mask like "gsk_a…9fQz". The raw key is never sent back to the browser.
  mask: string | null
  // Inferred server-side from the key prefix.
  provider: 'groq' | 'gemini' | 'anthropic' | null
}

export function getKeyStatus(): Promise<KeyStatus> {
  return request<KeyStatus>('/key')
}

// The server validates the key against Gemini before storing it, so a 400 here
// means the key itself was rejected.
export function saveKey(apiKey: string): Promise<KeyStatus> {
  return request<KeyStatus>('/key', {
    method: 'PUT',
    body: JSON.stringify({ apiKey }),
  })
}

export function deleteKey(): Promise<KeyStatus> {
  return request<KeyStatus>('/key', { method: 'DELETE' })
}

// The single pre-scored example, visible without signing in.
export function getDemoJob(): Promise<ScoredJob | null> {
  return request<ScoredJob | null>('/demo')
}

export function getProfile(): Promise<Profile | null> {
  return request<Profile | null>('/profile')
}

export function saveProfile(profile: Profile): Promise<Profile> {
  return request<Profile>('/profile', {
    method: 'PUT',
    body: JSON.stringify(profile),
  })
}

export function fetchJobs(): Promise<FetchResult> {
  return request<FetchResult>('/fetch', { method: 'POST' })
}

export function rescoreJobs(): Promise<RescoreResult> {
  return request<RescoreResult>('/rescore', { method: 'POST' })
}

export interface JobPage {
  jobs: ScoredJob[]
  /** Rows matching the filter server-side, which may exceed those returned. */
  total: number
}

/**
 * One page of scored jobs.
 *
 * The server caps a page and reports the true match count in x-total-count, so
 * the UI can say "showing 200 of 1,724" instead of silently truncating. The
 * list no longer carries full descriptions — the endpoint sends a 400-char
 * snippet, and nothing in the list view renders them anyway.
 */
export async function getJobs(minScore: number, source = '', limit = 300): Promise<JobPage> {
  const q = new URLSearchParams({ minScore: String(minScore), limit: String(limit) })
  if (source) q.set('source', source)
  const { data, headers } = await requestWithHeaders<ScoredJob[]>(`/jobs?${q}`)
  const total = Number(headers.get('x-total-count'))
  return { jobs: data, total: Number.isFinite(total) && total > 0 ? total : data.length }
}

export interface HealthRow {
  name: string
  configured: boolean
  state: 'ok' | 'quota' | 'auth' | 'error' | 'idle' | 'off'
  detail: string | null
  lastItems: number
  inPool: number
  checkedAt: string | null
  retryAfter: string | null
}

export interface LlmRow {
  name: string
  configured: boolean
  /** Position in the failover chain, 1-based. Null when not configured. */
  order: number | null
  state: 'ok' | 'quota' | 'auth' | 'error' | 'idle' | 'off'
  detail: string | null
  checkedAt: string | null
  retryAfter: string | null
}

export interface UsageRow {
  name: string
  label: string
  kind: 'model' | 'jobs' | 'scrape'
  /** Requests allowed per window, or null where the plan sets no request cap. */
  limit: number | null
  window: 'day' | 'month'
  note: string
  used: number
  /** Clamped to 1, so an overspent plan cannot overflow its bar. Null when uncapped. */
  fraction: number | null
  remaining: number | null
  resetsAt: string
}

export interface SystemStatus {
  jobSources: HealthRow[]
  llm: LlmRow[]
  scrapers: { name: string; configured: boolean }[]
  queue: { total: number; enabled: number; dueNow: number; neverScraped: number; producing: number } | null
  scrapeTargets: number
  usage: UsageRow[]
}

/** What is working right now — every third-party quota this app leans on. */
export function getStatus(): Promise<SystemStatus> {
  return request<SystemStatus>('/status')
}

export interface SourceInfo {
  sources: { name: string; count: number }[]
  scrapers: { name: string; configured: boolean }[]
  /** How many career-page URLs the server is configured to read. Zero means
   *  career-page scraping cannot produce anything, whatever the providers say. */
  careerPageCount?: number
}

// Which job sources have jobs in the pool — drives the dashboard tabs.
export function getSources(): Promise<SourceInfo> {
  return request<SourceInfo>('/sources')
}

export function patchJob(
  id: string,
  patch: { status?: JobStatus; notes?: string; dismissed?: boolean },
): Promise<ScoredJob> {
  return request<ScoredJob>(`/jobs/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function getOutreach(jobId: string): Promise<Outreach | null> {
  return request<Outreach | null>(`/jobs/${jobId}/outreach`)
}

export function generateOutreach(
  jobId: string,
  regenerate = false,
): Promise<Outreach> {
  return request<Outreach>(`/jobs/${jobId}/outreach?regenerate=${regenerate}`, {
    method: 'POST',
  })
}
