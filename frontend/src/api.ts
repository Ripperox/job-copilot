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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
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

export function getJobs(minScore: number): Promise<ScoredJob[]> {
  return request<ScoredJob[]>(`/jobs?minScore=${minScore}`)
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
