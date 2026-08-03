import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JobStatus, ScoredJob } from '../api'
import { JOB_STATUSES, UnauthorizedError, fetchJobs, getJobs, rescoreJobs } from '../api'
import JobCard from './JobCard'

const SCORE_OPTIONS = [0, 50, 60, 70, 80]

const STATUS_LABELS: Record<JobStatus, string> = {
  new: 'New',
  outreach: 'Outreach',
  applied: 'Applied',
  interview: 'Interview',
  rejected: 'Rejected',
}

type StatusFilter = 'all' | JobStatus

export default function Dashboard({ onUnauthorized }: { onUnauthorized?: () => void }) {
  const [minScore, setMinScore] = useState(50)
  const [jobs, setJobs] = useState<ScoredJob[]>([])
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [loadingList, setLoadingList] = useState(true)
  const [fetching, setFetching] = useState(false)
  const [rescoring, setRescoring] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const loadJobs = useCallback(async (score: number) => {
    setLoadingList(true)
    setError(null)
    try {
      const list = await getJobs(score)
      setJobs(list)
    } catch (err: unknown) {
      if (err instanceof UnauthorizedError) return onUnauthorized?.()
      setError(err instanceof Error ? err.message : 'Failed to load jobs')
    } finally {
      setLoadingList(false)
    }
  }, [onUnauthorized])

  useEffect(() => {
    void loadJobs(minScore)
  }, [minScore, loadJobs])

  // Local-state updates keep the summary bar + tabs accurate without a refetch.
  const handleUpdated = useCallback((updated: ScoredJob) => {
    setJobs((prev) => prev.map((j) => (j.id === updated.id ? updated : j)))
  }, [])

  const handleDismissed = useCallback((id: string) => {
    setJobs((prev) => prev.filter((j) => j.id !== id))
  }, [])

  const counts = useMemo(() => {
    const base: Record<JobStatus, number> = {
      new: 0,
      outreach: 0,
      applied: 0,
      interview: 0,
      rejected: 0,
    }
    for (const job of jobs) base[job.status] += 1
    return base
  }, [jobs])

  const visibleJobs = useMemo(
    () =>
      statusFilter === 'all'
        ? jobs
        : jobs.filter((j) => j.status === statusFilter),
    [jobs, statusFilter],
  )

  async function handleFetch() {
    setFetching(true)
    setError(null)
    setToast(null)
    try {
      const result = await fetchJobs()
      const sources =
        result.sources.length > 0 ? result.sources.join(', ') : 'sources'
      setToast(
        `Fetched from ${sources} (${result.total}) · scored ${result.scored}`,
      )
      await loadJobs(minScore)
      window.setTimeout(() => setToast(null), 5000)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to fetch jobs')
    } finally {
      setFetching(false)
    }
  }

  async function handleRescore() {
    setRescoring(true)
    setError(null)
    setToast(null)
    try {
      const result = await rescoreJobs()
      setToast(`Re-scored ${result.rescored} jobs`)
      await loadJobs(minScore)
      window.setTimeout(() => setToast(null), 5000)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to re-score jobs')
    } finally {
      setRescoring(false)
    }
  }

  return (
    <div className="stack">
      <div className="toolbar">
        <button
          className="btn btn-primary"
          onClick={handleFetch}
          disabled={fetching || rescoring}
        >
          {fetching ? 'Fetching & scoring…' : 'Fetch & score jobs'}
        </button>

        <button
          className="btn"
          onClick={handleRescore}
          disabled={fetching || rescoring || jobs.length === 0}
          title="Re-score all fetched jobs against your current profile (e.g. after adding an API key)"
        >
          {rescoring ? 'Re-scoring…' : 'Re-score'}
        </button>

        <label className="filter">
          <span>Min score</span>
          <select
            className="input input-select"
            value={minScore}
            onChange={(e) => setMinScore(Number(e.target.value))}
          >
            {SCORE_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s === 0 ? 'All' : `${s}+`}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!loadingList && jobs.length > 0 && (
        <div className="summary-bar">
          <div className="summary-total">
            <span className="summary-total-num">{jobs.length}</span>
            <span className="summary-total-label">Total matches</span>
          </div>
          <div className="summary-chips">
            {JOB_STATUSES.map((s) => (
              <span key={s} className={`summary-chip status-${s}`}>
                <span className="summary-chip-label">{STATUS_LABELS[s]}</span>
                <span className="summary-chip-count">{counts[s]}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {!loadingList && jobs.length > 0 && (
        <div className="status-tabs" role="tablist" aria-label="Filter by status">
          <button
            type="button"
            role="tab"
            aria-selected={statusFilter === 'all'}
            className={`status-tab${statusFilter === 'all' ? ' status-tab-active' : ''}`}
            onClick={() => setStatusFilter('all')}
          >
            All <span className="status-tab-count">{jobs.length}</span>
          </button>
          {JOB_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={statusFilter === s}
              className={`status-tab status-${s}${
                statusFilter === s ? ' status-tab-active' : ''
              }`}
              onClick={() => setStatusFilter(s)}
            >
              {STATUS_LABELS[s]}{' '}
              <span className="status-tab-count">{counts[s]}</span>
            </button>
          ))}
        </div>
      )}

      {toast && <div className="banner banner-ok">{toast}</div>}
      {error && <div className="banner banner-error">{error}</div>}

      {loadingList ? (
        <p className="muted">Loading jobs…</p>
      ) : jobs.length === 0 ? (
        <div className="card empty">
          <h3>No jobs yet</h3>
          <p className="muted">
            Head to <strong>Profile</strong>, paste your resume and preferences,
            then come back and click <strong>Fetch &amp; score jobs</strong>.
            {minScore > 0 && (
              <>
                {' '}
                You can also lower the <strong>Min score</strong> filter to see
                more matches.
              </>
            )}
          </p>
        </div>
      ) : visibleJobs.length === 0 ? (
        <div className="card empty">
          <h3>No {STATUS_LABELS[statusFilter as JobStatus]} jobs</h3>
          <p className="muted">
            None of your current matches are in this status. Switch back to{' '}
            <strong>All</strong> to see everything.
          </p>
        </div>
      ) : (
        <div className="job-list">
          {visibleJobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              onUpdated={handleUpdated}
              onDismissed={handleDismissed}
            />
          ))}
        </div>
      )}
    </div>
  )
}
