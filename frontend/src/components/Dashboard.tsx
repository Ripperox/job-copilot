import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { JobStatus, ScoredJob, SourceInfo } from '../api'
import { JOB_STATUSES, UnauthorizedError, fetchJobs, getJobs, getSources, rescoreJobs } from '../api'
import JobCard from './JobCard'
import DashError, { describeError } from './DashError'
import type { DashErrorInfo } from './DashError'
import DashRunPanel, { formatElapsed } from './DashRunPanel'
import type { RunPhase } from './DashRunPanel'
import DashSkeleton from './DashSkeleton'
import '../styles/dashboard.css'

// Two dashboards, one component — because the data plumbing is identical and the
// presentation is not. Career pages are a short, high-value reading list; job
// boards are a long queue to triage. They are laid out, worded and paced
// differently on purpose, and neither is a filter tab on the other.

const SCORE_OPTIONS = [0, 50, 60, 70, 80]

const STATUS_LABELS: Record<JobStatus, string> = {
  new: 'New',
  outreach: 'Outreach',
  applied: 'Applied',
  interview: 'Interview',
  rejected: 'Rejected',
}

type StatusFilter = 'all' | JobStatus

/** The backend's source key for roles read off company career pages. */
const CAREER_PAGES = 'scraped'

type Note = { title: string; line: string; meta: string }

function daysSince(iso: string | null): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  return Math.floor((Date.now() - t) / 86_400_000)
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

function freshLabel(days: number): string {
  if (days <= 0) return 'Posted today'
  if (days === 1) return 'Posted yesterday'
  return `Posted ${days} days ago`
}

export default function Dashboard({
  view,
  onUnauthorized,
}: {
  view: 'career-pages' | 'job-boards'
  onUnauthorized?: () => void
}) {
  const career = view === 'career-pages'
  const uid = useId()

  const [minScore, setMinScore] = useState(50)
  const [jobs, setJobs] = useState<ScoredJob[]>([])
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<DashErrorInfo | null>(null)
  const [actionError, setActionError] = useState<{
    info: DashErrorInfo
    retry: () => void
  } | null>(null)
  const [phase, setPhase] = useState<RunPhase>('idle')
  const [note, setNote] = useState<Note | null>(null)
  const [sources, setSources] = useState<SourceInfo | null>(null)

  // Guards against a slow response from the view you just left overwriting the
  // list of the view you are now looking at.
  const reqId = useRef(0)

  const load = useCallback(
    async (score: number) => {
      const id = ++reqId.current
      setLoading(true)
      setLoadError(null)
      try {
        // getJobs takes one source, so career pages filter server-side and the
        // boards view subtracts them client-side.
        const list = career
          ? await getJobs(score, CAREER_PAGES)
          : (await getJobs(score)).filter((j) => j.source !== CAREER_PAGES)
        if (id !== reqId.current) return
        setJobs(list)
      } catch (err: unknown) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized?.()
          return
        }
        if (id !== reqId.current) return
        setLoadError(describeError(err, 'load'))
      } finally {
        if (id === reqId.current) setLoading(false)
      }
    },
    [career, onUnauthorized],
  )

  // A different dashboard is a different product, not a filtered view of this
  // one — start it clean. Declared before the loader so it wins the render.
  useEffect(() => {
    setStatusFilter('all')
    setJobs([])
    setNote(null)
    setActionError(null)
  }, [view])

  useEffect(() => {
    void load(minScore)
  }, [load, minScore])

  useEffect(() => {
    let active = true
    getSources()
      .then((s) => active && setSources(s))
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [jobs.length])

  useEffect(() => {
    if (!note) return
    const id = window.setTimeout(() => setNote(null), 9000)
    return () => window.clearTimeout(id)
  }, [note])

  // Local updates keep the counts honest without a refetch.
  const handleUpdated = useCallback((updated: ScoredJob) => {
    setJobs((prev) => prev.map((j) => (j.id === updated.id ? updated : j)))
  }, [])

  const handleDismissed = useCallback((id: string) => {
    setJobs((prev) => prev.filter((j) => j.id !== id))
  }, [])

  async function handleFetch() {
    setPhase('fetching')
    setActionError(null)
    setNote(null)
    const startedAt = Date.now()
    try {
      const result = await fetchJobs()
      const secs = Math.round((Date.now() - startedAt) / 1000)
      const from =
        result.sources.length > 0 ? result.sources.join(', ') : 'your sources'
      setNote({
        title: 'Fetch finished',
        line:
          result.scored > 0
            ? `Scored ${result.scored} new ${result.scored === 1 ? 'posting' : 'postings'} from ${from}.`
            : `Nothing new from ${from} this time — everything on offer was already in your pool.`,
        meta: `${result.total} in the pool · ${formatElapsed(secs)}`,
      })
      await load(minScore)
    } catch (err: unknown) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized?.()
        return
      }
      const info = describeError(err, 'fetch')
      setActionError({
        info,
        retry: info.prefersReload
          ? () => void load(minScore)
          : () => void handleFetch(),
      })
    } finally {
      setPhase('idle')
    }
  }

  async function handleRescore() {
    setPhase('rescoring')
    setActionError(null)
    setNote(null)
    const startedAt = Date.now()
    try {
      const result = await rescoreJobs()
      const secs = Math.round((Date.now() - startedAt) / 1000)
      setNote({
        title: 'Re-scoring finished',
        line: `Re-scored ${result.rescored} ${result.rescored === 1 ? 'job' : 'jobs'} against your current profile.`,
        meta: formatElapsed(secs),
      })
      await load(minScore)
    } catch (err: unknown) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized?.()
        return
      }
      const info = describeError(err, 'rescore')
      setActionError({
        info,
        retry: info.prefersReload
          ? () => void load(minScore)
          : () => void handleRescore(),
      })
    } finally {
      setPhase('idle')
    }
  }

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
    () => (statusFilter === 'all' ? jobs : jobs.filter((j) => j.status === statusFilter)),
    [jobs, statusFilter],
  )

  const freshCount = useMemo(
    () =>
      jobs.filter((j) => {
        const d = daysSince(j.postedAt ?? j.createdAt)
        return d !== null && d <= 7
      }).length,
    [jobs],
  )

  const boardSources = useMemo(
    () => (sources?.sources ?? []).filter((s) => s.name !== CAREER_PAGES),
    [sources],
  )

  const inPlay = counts.outreach + counts.applied + counts.interview
  // Scraping is only really "on" when a provider AND a URL list both exist.
  // Jina needs no key so it always reports configured — checking providers
  // alone made an unconfigured server promise roles that could never arrive.
  const scrapingOn = sources
    ? sources.scrapers.some((s) => s.configured) && (sources.careerPageCount ?? 0) > 0
    : true
  const poolForView = career
    ? (sources?.sources ?? []).find((s) => s.name === CAREER_PAGES)?.count ?? 0
    : boardSources.reduce((n, s) => n + s.count, 0)

  const listId = `${uid}-list`

  // ---- controls (same two filters in both views, laid out differently) ----

  const statusChoices = career
    ? JOB_STATUSES.filter((s) => counts[s] > 0 || s === statusFilter)
    : JOB_STATUSES

  const filters = (
    <>
      <div className="dsh-ctl">
        <span className="dsh-ctl-k" id={`${uid}-score`}>
          Minimum score
        </span>
        <div className="dsh-scores" role="group" aria-labelledby={`${uid}-score`}>
          {SCORE_OPTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className={`dsh-score${s === minScore ? ' is-on' : ''}`}
              aria-pressed={s === minScore}
              onClick={() => setMinScore(s)}
            >
              {s === 0 ? 'Any' : <span className="dsh-num">{s}+</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="dsh-ctl">
        <span className="dsh-ctl-k" id={`${uid}-status`}>
          Status
        </span>
        <div className="dsh-tabs" role="tablist" aria-labelledby={`${uid}-status`}>
          <button
            type="button"
            role="tab"
            aria-selected={statusFilter === 'all'}
            aria-controls={listId}
            className="dsh-tab dsh-c-all"
            onClick={() => setStatusFilter('all')}
          >
            All
            <span className="dsh-tab-n">{jobs.length}</span>
          </button>
          {statusChoices.map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={statusFilter === s}
              aria-controls={listId}
              className={`dsh-tab dsh-c-${s}`}
              onClick={() => setStatusFilter(s)}
            >
              {STATUS_LABELS[s]}
              <span className="dsh-tab-n">{counts[s]}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  )

  // ---- empty states ----

  // (Removed the decorative "ghost" bars that used to sit under empty states —
  // they were visually identical to the loading skeleton, so an empty list read
  // as a list still loading. An empty state should look settled, not pending.)

  function emptyPool(): ReactNode {
    if (career && !scrapingOn) {
      return (
        <div className="dsh-empty">
          <h3 className="dsh-empty-t">Career-page reading isn’t switched on</h3>
          <p className="dsh-empty-b">
            This dashboard reads roles directly off company career pages. That
            needs a scraping provider — Firecrawl or Tavily — configured on the
            server, along with the list of career-page URLs to watch.
          </p>
          <p className="dsh-empty-b">
            Until then the job boards dashboard is where your listings will show
            up.
          </p>
        </div>
      )
    }

    if (minScore > 0 && poolForView > 0) {
      return (
        <div className="dsh-empty">
          <h3 className="dsh-empty-t">
            Nothing scores <span className="dsh-num">{minScore}</span> or higher
          </h3>
          <p className="dsh-empty-b">
            {career
              ? 'There are career-page roles in the pool, but none of them clear your score floor right now. Career pages are a small, slow trickle — it is worth reading the ones that scored lower.'
              : 'There are board listings in the pool, but none of them clear your score floor. Drop the bar and skim what is underneath, or run a fetch for something newer.'}
          </p>
          <div className="dsh-empty-acts">
            <button type="button" className="dsh-btn" onClick={() => setMinScore(0)}>
              Show every score
            </button>
          </div>
        </div>
      )
    }

    if (career) {
      return (
        <div className="dsh-empty">
          <h3 className="dsh-empty-t">No career-page roles yet</h3>
          <p className="dsh-empty-b">
            Company career pages are re-read every few hours rather than on every
            fetch, so this list fills slowly and stays short on purpose — that is
            the point of it.
          </p>
          <p className="dsh-empty-b">
            Run a fetch to check now. If your profile is still empty, set that
            first: nothing can be scored without it.
          </p>
        </div>
      )
    }

    return (
      <div className="dsh-empty">
        <h3 className="dsh-empty-t">No board listings yet</h3>
        <p className="dsh-empty-b">
          Job boards are the aggregators — Adzuna, Jooble and the rest. A fetch
          fills this up in about a minute, as long as your profile is set so
          there is something to score against.
        </p>
        {minScore > 0 && (
          <p className="dsh-empty-b">
            You are also filtering to <span className="dsh-num">{minScore}</span>+
            — lowering that will show more.
          </p>
        )}
        {minScore > 0 && (
          <div className="dsh-empty-acts">
            <button type="button" className="dsh-btn" onClick={() => setMinScore(0)}>
              Show every score
            </button>
          </div>
        )}
      </div>
    )
  }

  function emptyStatus(): ReactNode {
    const label =
      statusFilter === 'all' ? '' : STATUS_LABELS[statusFilter].toLowerCase()
    return (
      <div className="dsh-empty">
        <h3 className="dsh-empty-t">Nothing is marked {label}</h3>
        <p className="dsh-empty-b">
          {jobs.length === 1
            ? 'Your one match is in a different status.'
            : `None of your ${jobs.length} matches are in this status yet.`}{' '}
          Statuses move as you work: mark a role Outreach when you message
          someone, Applied when you send it.
        </p>
        <div className="dsh-empty-acts">
          <button
            type="button"
            className="dsh-btn"
            onClick={() => setStatusFilter('all')}
          >
            Show all {jobs.length}
          </button>
        </div>
      </div>
    )
  }

  // ---- the list ----

  let listRegion: ReactNode
  if (loading) {
    listRegion = <DashSkeleton rows={career ? 3 : 5} />
  } else if (loadError) {
    listRegion = (
      <div className="dsh-errslot">
        <DashError info={loadError} onRetry={() => void load(minScore)} />
      </div>
    )
  } else if (jobs.length === 0) {
    listRegion = emptyPool()
  } else if (visibleJobs.length === 0) {
    listRegion = emptyStatus()
  } else {
    listRegion = (
      <ul className="dsh-list">
        {visibleJobs.map((job, i) => {
          const days = daysSince(job.postedAt ?? job.createdAt)
          const host = hostOf(job.url)
          return (
            <li className="dsh-item" key={job.id}>
              {career && (
                <p className="dsh-item-cap">
                  <span className="dsh-item-i">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  {host && <span className="dsh-item-host">{host}</span>}
                  {days !== null && days <= 7 && (
                    <span className="dsh-fresh">{freshLabel(days)}</span>
                  )}
                </p>
              )}
              <JobCard
                job={job}
                onUpdated={handleUpdated}
                onDismissed={handleDismissed}
              />
            </li>
          )
        })}
      </ul>
    )
  }

  const feedback = (
    <>
      {note && (
        <div className="dsh-note u-rise" role="status">
          <span className="dsh-note-tick" aria-hidden="true">
            ✓
          </span>
          <div className="dsh-note-txt">
            <p className="dsh-note-t">{note.title}</p>
            <p className="dsh-note-l">{note.line}</p>
          </div>
          <span className="dsh-note-meta">{note.meta}</span>
          <button
            type="button"
            className="dsh-note-x"
            onClick={() => setNote(null)}
            aria-label="Dismiss this message"
          >
            ×
          </button>
        </div>
      )}
      {actionError && (
        <DashError
          info={actionError.info}
          onRetry={actionError.retry}
          onDismiss={() => setActionError(null)}
        />
      )}
    </>
  )

  const runPanel = (
    <DashRunPanel
      phase={phase}
      layout={career ? 'rail' : 'bar'}
      canRescore={jobs.length > 0 || poolForView > 0}
      onFetch={() => void handleFetch()}
      onRescore={() => void handleRescore()}
    />
  )

  // ---------------------------------------------------------------- career
  if (career) {
    return (
      <div className="dsh dsh-career">
        <header className="dsh-head">
          <div className="dsh-head-txt">
            <p className="dsh-eyebrow">
              <span className="dsh-dot" aria-hidden="true" />
              Career pages
            </p>
            <h2 className="dsh-h1">Read straight off company sites</h2>
            <p className="dsh-lede">
              These roles came from a company’s own careers page rather than an
              aggregator — usually days earlier, and in front of far fewer people.
              There are only ever a handful, so read them properly instead of
              skimming.
            </p>
          </div>
        </header>

        <div className="dsh-body">
          <aside className="dsh-rail">
            <div className="dsh-card">
              {runPanel}
              <p className="dsh-fine">
                A fetch reads every source. Career pages are only re-read every
                few hours, so this list will not always change.
              </p>
            </div>

            <div className="dsh-card dsh-filters">{filters}</div>
          </aside>

          <main className="dsh-main" id={listId}>
            {feedback}
            {!loading && jobs.length > 0 && (
              <p className="dsh-count">
                <span className="dsh-num">{jobs.length}</span>{' '}
                {jobs.length === 1 ? 'role' : 'roles'} above{' '}
                {minScore === 0 ? 'any score' : <span className="dsh-num">{minScore}</span>}
                {freshCount > 0 && (
                  <>
                    {' · '}
                    <span className="dsh-num">{freshCount}</span> posted this week
                  </>
                )}
                {statusFilter !== 'all' && (
                  <>
                    {' · showing '}
                    <span className="dsh-num">{visibleJobs.length}</span>{' '}
                    {STATUS_LABELS[statusFilter].toLowerCase()}
                  </>
                )}
              </p>
            )}
            {listRegion}
          </main>

          {/* Last in the DOM so a phone reads controls, then roles, then this. */}
          <aside className="dsh-aside">
            <div className="dsh-card">
              <h3 className="dsh-card-t">Why these are worth the time</h3>
              <dl className="dsh-why-list">
                <div>
                  <dt>Barely contested</dt>
                  <dd>
                    Many never reach an aggregator at all. The ones that do land
                    there days later, behind hundreds of applications.
                  </dd>
                </div>
                <div>
                  <dt>As current as it gets</dt>
                  <dd>
                    Read off the company’s own page, so nothing here is a stale
                    relist from a third party.
                  </dd>
                </div>
                <div>
                  <dt>Few enough to read</dt>
                  <dd>
                    A handful, not hundreds. Open each one, read the verdict, and
                    write a note you would actually send.
                  </dd>
                </div>
              </dl>
            </div>
          </aside>
        </div>
      </div>
    )
  }

  // ------------------------------------------------------------ job boards
  return (
    <div className="dsh dsh-boards">
      <header className="dsh-head">
        <div className="dsh-head-txt">
          <p className="dsh-eyebrow">Job boards</p>
          <h2 className="dsh-h1">Everything the aggregators are carrying</h2>
          <p className="dsh-lede">
            Adzuna, Jooble and the rest — the same listings everyone else is
            looking at. Volume is the point: set a score floor, work down from the
            top, and move on quickly.
          </p>
        </div>

        <div className="dsh-readout">
          <div className="dsh-stats">
            <div className="dsh-stat is-lead">
              <span className={`dsh-stat-v${loading ? ' is-wait' : ''}`}>
                {loading ? '—' : jobs.length}
              </span>
              <span className="dsh-stat-k">
                {minScore === 0 ? 'matches' : `matches at ${minScore}+`}
              </span>
            </div>
            <div className="dsh-stat">
              <span className={`dsh-stat-v${loading ? ' is-wait' : ''}`}>
                {loading ? '—' : visibleJobs.length}
              </span>
              <span className="dsh-stat-k">showing</span>
            </div>
            <div className="dsh-stat">
              <span className={`dsh-stat-v${loading ? ' is-wait' : ''}`}>
                {loading ? '—' : inPlay}
              </span>
              <span className="dsh-stat-k">in play</span>
            </div>
          </div>
          {jobs.length > 0 && (
            <div
              className="dsh-mix"
              aria-hidden="true"
              title="Status mix across your matches"
            >
              {JOB_STATUSES.map((s) =>
                counts[s] > 0 ? (
                  <span
                    key={s}
                    className={`dsh-mix-seg dsh-c-${s}`}
                    style={{ flexGrow: counts[s] }}
                  />
                ) : null,
              )}
            </div>
          )}
        </div>
      </header>

      <section className="dsh-console" aria-label="Controls and filters">
        <div className="dsh-console-row is-top">
          {runPanel}
          {boardSources.length > 0 && (
            <p className="dsh-legend">
              <span className="dsh-legend-k">In the pool</span>
              {boardSources.map((s) => (
                <span className="dsh-legend-i" key={s.name}>
                  {s.name}
                  <span className="dsh-legend-n">{s.count}</span>
                </span>
              ))}
            </p>
          )}
        </div>

        <div className="dsh-console-row is-filters">{filters}</div>
      </section>

      {feedback}

      <div className="dsh-body">
        <main className="dsh-main" id={listId}>
          {listRegion}
        </main>
      </div>
    </div>
  )
}
