export const API = 'http://localhost:4500/api'

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
  llm: 'groq' | 'anthropic' | 'heuristic'
  adzuna: boolean
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
    ...init,
  })
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
