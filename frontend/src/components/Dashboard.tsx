import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JobStatus, ScoredJob } from '../api'
import { JOB_STATUSES, UnauthorizedError, fetchJobs, getJobs, getSources, rescoreJobs } from '../api'
import JobCard from './JobCard'
import '../styles/dashboard.css'

const SCORE_OPTIONS = [0, 50, 60, 70, 80]

const STATUS_LABELS: Record<JobStatus, string> = {
  new: 'New',
  outreach: 'Outreach',
  applied: 'Applied',
  interview: 'Interview',
  rejected: 'Rejected',
}

type StatusFilter = 'all' | JobStatus

// The source key the backend uses for company career pages — the differentiated
// supply, so it gets the accent marker in the source strip.
const CAREER_PAGES = 'scraped'

function sourceLabelFor(name: string): string {
  if (name === '') return 'all'
  return name === CAREER_PAGES ? 'career-pages' : name
}

export default function Dashboard({ onUnauthorized }: { onUnauthorized?: () => void }) {
  const [minScore, setMinScore] = useState(50)
  // '' = every source; 'scraped' = the career-pages view.
  const [sourceFilter, setSourceFilter] = useState('')
  const [sourceCounts, setSourceCounts] = useState<{ name: string; count: number }[]>([])
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
      const list = await getJobs(score, sourceRef.current)
      setJobs(list)
    } catch (err: unknown) {
      if (err instanceof UnauthorizedError) return onUnauthorized?.()
      setError(err instanceof Error ? err.message : 'Failed to load jobs')
    } finally {
      setLoadingList(false)
    }
  }, [onUnauthorized])

  // Keep the current source in a ref so loadJobs stays stable and the existing
  // callers (fetch, rescore, filter changes) do not all need rewiring.
  const sourceRef = useRef('')
  useEffect(() => {
    sourceRef.current = sourceFilter
  }, [sourceFilter])

  useEffect(() => {
    void loadJobs(minScore)
  }, [minScore, sourceFilter, loadJobs])

  useEffect(() => {
    let active = true
    getSources()
      .then((s) => active && setSourceCounts(s.sources))
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [jobs.length])

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

  // Telemetry only — derived from state already on screen, no extra requests.
  const inPlay = counts.outreach + counts.applied + counts.interview
  const srcLabel = sourceLabelFor(sourceFilter)
  const busy = fetching || rescoring

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
    <div className="dsh">
      {/* ---- 01 · command deck ------------------------------------------- */}
      <div className="dsh-sechead">
        <span className="dsh-secidx">01</span>
        <span className="dsh-secrule" />
        <span className="dsh-seccmd">$ fetch --score</span>
      </div>

      <div className="dsh-deck corner-frame">
        <button
          type="button"
          className="dsh-run"
          onClick={handleFetch}
          disabled={fetching || rescoring}
        >
          <span className="dsh-run-glyph" aria-hidden="true">
            ▸
          </span>
          {fetching ? 'Fetching & scoring…' : 'Fetch & score jobs'}
        </button>

        <button
          type="button"
          className="dsh-btn"
          onClick={handleRescore}
          disabled={fetching || rescoring || jobs.length === 0}
          title="Re-score all fetched jobs against your current profile (e.g. after adding an API key)"
        >
          {rescoring ? 'Re-scoring…' : 'Re-score'}
        </button>

        {busy && (
          <span className="dsh-busy">
            <span className="live-dot" aria-hidden="true" />
            running
          </span>
        )}

        <label className="dsh-field">
          <span className="dsh-field-label">Min score</span>
          <span className="dsh-field-ctl">
            <select
              className="dsh-select"
              value={minScore}
              onChange={(e) => setMinScore(Number(e.target.value))}
            >
              {SCORE_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s === 0 ? 'All' : `${s}+`}
                </option>
              ))}
            </select>
          </span>
        </label>
      </div>

      {toast && (
        <div className="dsh-log dsh-log-ok" role="status">
          <span className="dsh-log-tag">ok</span>
          <span className="dsh-log-msg">{toast}</span>
        </div>
      )}
      {error && (
        <div className="dsh-log dsh-log-err" role="alert">
          <span className="dsh-log-tag">err</span>
          <span className="dsh-log-msg">{error}</span>
        </div>
      )}

      {/* ---- 02 · the scope. The header echoes the live query. ------------ */}
      <div className="dsh-sechead dsh-sechead-gap">
        <span className="dsh-secidx">02</span>
        <span className="dsh-secrule" />
        <span className="dsh-seccmd">
          $ jobs <span className="dsh-flag">--min</span>{' '}
          <span className="dsh-val">{minScore === 0 ? 'any' : minScore}</span>{' '}
          <span className="dsh-flag">--src</span>{' '}
          <span className="dsh-val">{srcLabel}</span>{' '}
          <span className="dsh-flag">--status</span>{' '}
          <span className="dsh-val">{statusFilter}</span>
        </span>
      </div>

      {(sourceCounts.length > 1 || (!loadingList && jobs.length > 0)) && (
        <div className="dsh-scope">
          {sourceCounts.length > 1 && (
            <div className="dsh-row">
              <span className="dsh-rowlabel">source</span>
              <div className="dsh-seg" role="tablist" aria-label="Filter by source">
                <button
                  type="button"
                  role="tab"
                  aria-selected={sourceFilter === ''}
                  className={`dsh-seg-btn${sourceFilter === '' ? ' is-on' : ''}`}
                  onClick={() => setSourceFilter('')}
                >
                  <span className="dsh-seg-mark" aria-hidden="true" />
                  all sources
                </button>
                {sourceCounts.map((s) => (
                  <button
                    key={s.name}
                    type="button"
                    role="tab"
                    aria-selected={sourceFilter === s.name}
                    className={`dsh-seg-btn${sourceFilter === s.name ? ' is-on' : ''}${
                      s.name === CAREER_PAGES ? ' is-key' : ''
                    }`}
                    onClick={() => setSourceFilter(s.name)}
                    title={
                      s.name === CAREER_PAGES
                        ? 'Roles read straight off company career pages'
                        : undefined
                    }
                  >
                    <span className="dsh-seg-mark" aria-hidden="true" />
                    {s.name === CAREER_PAGES ? 'career pages' : s.name}
                    <span className="dsh-seg-n">{s.count}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {!loadingList && jobs.length > 0 && (
            <>
              <div className="dsh-row dsh-tele scanlines">
                <div className="dsh-readouts">
                  <div className="dsh-ro dsh-ro-lead">
                    <span className="dsh-ro-v">{jobs.length}</span>
                    <span className="dsh-ro-k">matches</span>
                  </div>
                  <div className="dsh-ro">
                    <span className="dsh-ro-k">shown</span>
                    <span className="dsh-ro-v">{visibleJobs.length}</span>
                  </div>
                  <div className="dsh-ro">
                    <span className="dsh-ro-k">in play</span>
                    <span className="dsh-ro-v">{inPlay}</span>
                  </div>
                  <div className="dsh-ro">
                    <span className="dsh-ro-k">min</span>
                    <span className="dsh-ro-v">{minScore === 0 ? '—' : minScore}</span>
                  </div>
                  <div className="dsh-ro">
                    <span className="dsh-ro-k">src</span>
                    <span className="dsh-ro-v dsh-ro-v-txt">{srcLabel}</span>
                  </div>
                </div>

                {/* Proportion, not numbers — the tabs below carry the counts. */}
                <div className="dsh-mix" aria-hidden="true">
                  {JOB_STATUSES.map((s) =>
                    counts[s] > 0 ? (
                      <span
                        key={s}
                        className={`dsh-mix-seg dsh-c-${s}`}
                        style={{ flexGrow: counts[s] }}
                        title={`${STATUS_LABELS[s]} ${counts[s]}`}
                      />
                    ) : null,
                  )}
                </div>
              </div>

              <div className="dsh-row">
                <span className="dsh-rowlabel">status</span>
                <div className="dsh-tabs" role="tablist" aria-label="Filter by status">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={statusFilter === 'all'}
                    className={`dsh-tab dsh-c-all${statusFilter === 'all' ? ' is-on' : ''}`}
                    onClick={() => setStatusFilter('all')}
                  >
                    <span className="dsh-tab-k">All</span>
                    <span className="dsh-tab-n">{jobs.length}</span>
                  </button>
                  {JOB_STATUSES.map((s) => (
                    <button
                      key={s}
                      type="button"
                      role="tab"
                      aria-selected={statusFilter === s}
                      className={`dsh-tab dsh-c-${s}${statusFilter === s ? ' is-on' : ''}`}
                      onClick={() => setStatusFilter(s)}
                    >
                      <span className="dsh-tab-k">{STATUS_LABELS[s]}</span>
                      <span className="dsh-tab-n">{counts[s]}</span>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ---- the stream --------------------------------------------------- */}
      {loadingList ? (
        <div className="dsh-loading">
          <span className="dsh-caret" aria-hidden="true" />
          reading index…
        </div>
      ) : jobs.length === 0 ? (
        <div className="dsh-empty corner-frame">
          <span className="dsh-empty-tag">0 rows</span>
          <h3 className="dsh-empty-title">No jobs yet</h3>
          <p className="dsh-empty-body">
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
        <div className="dsh-empty corner-frame">
          <span className="dsh-empty-tag">0 rows</span>
          <h3 className="dsh-empty-title">
            No {STATUS_LABELS[statusFilter as JobStatus]} jobs
          </h3>
          <p className="dsh-empty-body">
            None of your current matches are in this status. Switch back to{' '}
            <strong>All</strong> to see everything.
          </p>
        </div>
      ) : (
        <>
          <div className="dsh-list">
            {visibleJobs.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                onUpdated={handleUpdated}
                onDismissed={handleDismissed}
              />
            ))}
          </div>
          <div className="dsh-eof">
            <span>eof</span>
            <span className="dsh-eof-rule" aria-hidden="true" />
            <span>
              {visibleJobs.length} {visibleJobs.length === 1 ? 'row' : 'rows'}
            </span>
          </div>
        </>
      )}
    </div>
  )
}
