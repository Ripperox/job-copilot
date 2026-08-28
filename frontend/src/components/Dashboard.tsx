import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { JobStatus, ScoredJob, SourceInfo, RescoreProgress } from '../api'
import { JOB_STATUSES, UnauthorizedError, fetchJobs, getJobs, getProfile, getRescoreStatus, getSources, startRescore } from '../api'
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
//
// What changed in v3: both are now built around the list rather than around a
// page header. The title block is one compact strip, the filters live in a bar
// that sticks under the app bar so you can re-filter from 6,000px down the
// queue without scrolling back, and the marketing-shaped side panel that used
// to take a third of the career dashboard is a footnote you can open.

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

export default function Dashboard({
  view,
  onUnauthorized,
  onSwitchView,
}: {
  view: 'career-pages' | 'job-boards'
  onUnauthorized?: () => void
  /** Jump to the other dashboard — used by the empty state's cross-reference. */
  onSwitchView?: (view: 'career-pages' | 'job-boards' | 'profile') => void
}) {
  const career = view === 'career-pages'
  const uid = useId()
  const still = useReducedMotion()

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
  // Live progress of a background rescore. Null when none is running.
  const [rescore, setRescore] = useState<RescoreProgress | null>(null)
  const [sources, setSources] = useState<SourceInfo | null>(null)
  // How many roles clear the CURRENT floor on the other dashboard. Shown in the
  // empty state so "nothing here" never reads as "nothing anywhere" — the most
  // common confusion when career pages is thin and the boards are full.
  const [otherCount, setOtherCount] = useState(0)
  // Rows matching the filter on the server, which can exceed those returned.
  const [matchTotal, setMatchTotal] = useState(0)
  const [hasResume, setHasResume] = useState<boolean | null>(null)

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
        const page = career ? await getJobs(score, CAREER_PAGES) : await getJobs(score)
        const list = career ? page.jobs : page.jobs.filter((j) => j.source !== CAREER_PAGES)
        if (id !== reqId.current) return
        setJobs(list)
        // The server caps a page; show the true match count so a capped list
        // never silently looks like the whole set.
        setMatchTotal(career ? page.total : page.total - (page.jobs.length - list.length))
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

  useEffect(() => {
    let active = true
    getProfile()
      .then((p) => {
        if (active) setHasResume((p?.resumeText?.trim()?.length ?? 0) > 0)
      })
      .catch(() => {
        if (active) setHasResume(null)
      })
    return () => {
      active = false
    }
  }, [])

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
    let active = true
    const load = career
      ? getJobs(minScore).then((p) => p.jobs.filter((j) => j.source !== CAREER_PAGES).length)
      : getJobs(minScore, CAREER_PAGES).then((p) => p.jobs.length)
    load.then((n) => active && setOtherCount(n)).catch(() => undefined)
    return () => {
      active = false
    }
  }, [career, minScore, jobs.length])

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
    // Keep the server-side match total in step. Without this the "showing N of
    // M" notice fired the moment you dismissed anything: dismissing one of ten
    // gave "Showing 9 of 10 matches — raise the score floor to narrow it",
    // which is both wrong and useless advice.
    setMatchTotal((n) => Math.max(0, n - 1))
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

  // Rescoring the whole pool takes minutes, so the server runs it in the
  // background and we follow along. Awaiting one long request is what used to
  // leave the pool half-scored: the connection died well before the work did.
  async function handleRescore() {
    setPhase('rescoring')
    setActionError(null)
    setNote(null)
    setRescore(null)
    const startedAt = Date.now()
    try {
      const begun = await startRescore()
      setRescore(begun.progress)

      // Poll until the server says it is done. Two seconds is often enough that
      // the bar visibly moves, and cheap enough to leave running for ten minutes.
      const final = await new Promise<RescoreProgress | null>((resolve, reject) => {
        const timer = window.setInterval(() => {
          getRescoreStatus()
            .then((s) => {
              if (s.progress) setRescore(s.progress)
              if (!s.running) {
                window.clearInterval(timer)
                resolve(s.progress)
              }
            })
            .catch((e) => {
              window.clearInterval(timer)
              reject(e)
            })
        }, 2000)
      })

      if (final?.error) throw new Error(final.error)

      const secs = Math.round((Date.now() - startedAt) / 1000)
      const n = final?.written ?? 0
      setNote({
        title: 'Re-scoring finished',
        line: final?.usedLLM
          ? `Read and scored ${n} ${n === 1 ? 'job' : 'jobs'} against your current profile.`
          : `Scored ${n} ${n === 1 ? 'job' : 'jobs'} by keyword. Add a scoring key on the Profile tab to get scores with reasons.`,
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

  // ---- controls (same two filters in both views, in one bar) ----

  const statusChoices = career
    ? JOB_STATUSES.filter((s) => counts[s] > 0 || s === statusFilter)
    : JOB_STATUSES

  const filters = (
    <>
      <div className="dsh-ctl">
        <span className="dsh-ctl-k" id={`${uid}-score`}>
          Score
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

      <div className="dsh-ctl dsh-ctl-status">
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
              className={`dsh-tab dsh-c-${s} st-${s}`}
              onClick={() => setStatusFilter(s)}
            >
              <i className="u-dot" aria-hidden="true" />
              {STATUS_LABELS[s]}
              <span className="dsh-tab-n">{counts[s]}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  )

  // ---- empty states ----
  //
  // An empty list is a real answer, so it gets a real page: a headline you can
  // read from across the room, two lines of why, and the one button that
  // resolves it. No ghost rows — those made an empty list look like a loading
  // one, which is the worst thing an empty state can do.

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
      if (hasResume === false) {
        return (
          <div className="dsh-empty dsh-empty-onboard">
            <div className="dsh-empty-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
                <polyline points="10 9 9 9 8 9" />
              </svg>
            </div>
            <h3 className="dsh-empty-t">Upload your résumé to see match scores</h3>
            <p className="dsh-empty-b">
              There {poolForView === 1 ? 'is' : 'are'}{' '}
              <span className="dsh-num">{poolForView.toLocaleString()}</span> {career ? 'career-page' : 'API'}{' '}
              {poolForView === 1 ? 'role' : 'roles'} waiting in your pipeline. Once you add your résumé in Profile, we will score every job against your exact stack and experience.
            </p>
            <div className="dsh-empty-acts">
              {onSwitchView && (
                <button
                  type="button"
                  className="dsh-btn dsh-btn-primary"
                  onClick={() => onSwitchView('profile')}
                >
                  Add résumé in Profile →
                </button>
              )}
              <button type="button" className="dsh-btn dsh-btn-go" onClick={() => setMinScore(0)}>
                Show all {poolForView} without scoring
              </button>
            </div>
          </div>
        )
      }

      // Say the NUMBERS. "Nothing scores 50 or higher" on its own reads as
      // "this feature is broken" when the truth is "19 roles exist and they are
      // all weak" — and it never mentions that the other dashboard is full,
      // which is the single most useful thing to know from here.
      const other = career ? 'API sources' : 'Career pages'
      return (
        <div className="dsh-empty">
          <h3 className="dsh-empty-t">
            Nothing scores <span className="dsh-num">{minScore}</span> or higher
          </h3>
          <p className="dsh-empty-b">
            {career ? (
              <>
                There {poolForView === 1 ? 'is' : 'are'}{' '}
                <span className="dsh-num">{poolForView}</span> career-page{' '}
                {poolForView === 1 ? 'role' : 'roles'} in the pool and none of them
                clear <span className="dsh-num">{minScore}</span>. Career pages are a
                slow trickle by design, so a thin patch is normal — the ones that
                scored lower are still worth a look.
              </>
            ) : (
              <>
                There {poolForView === 1 ? 'is' : 'are'}{' '}
                <span className="dsh-num">{poolForView}</span>{' '}
                {poolForView === 1 ? 'listing' : 'listings'} in the pool and none clear{' '}
                <span className="dsh-num">{minScore}</span>. Drop the bar to see what is
                underneath, or fetch for something newer.
              </>
            )}
          </p>
          <p className="dsh-empty-b">
            {otherCount > 0 ? (
              <>
                <span className="dsh-num">{otherCount}</span>{' '}
                {otherCount === 1 ? 'role' : 'roles'} on <strong>{other}</strong> clear{' '}
                <span className="dsh-num">{minScore}</span> right now.
              </>
            ) : (
              <>Nothing on <strong>{other}</strong> clears it either.</>
            )}
          </p>
          <div className="dsh-empty-acts">
            {/* When the matches are on the OTHER dashboard, going there is the
                useful next step, so it gets the primary action. Stating where
                the jobs are and leaving someone to find the tab is not help —
                this exact screen was read as "broken" four times running. */}
            {otherCount > 0 && onSwitchView && (
              <button
                type="button"
                className="dsh-btn dsh-btn-primary"
                onClick={() => onSwitchView(career ? 'job-boards' : 'career-pages')}
              >
                Go to {other} ({otherCount})
              </button>
            )}
            <button type="button" className="dsh-btn dsh-btn-go" onClick={() => setMinScore(0)}>
              Show all {poolForView} here
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
          These come from company ATS boards (Greenhouse, Lever, Ashby) and
          aggregators (Adzuna, Jooble). A fetch fills this up in about a minute,
          as long as your profile is set so there is something to score against.
        </p>
        {minScore > 0 && (
          <p className="dsh-empty-b">
            You are also filtering to <span className="dsh-num">{minScore}</span>+
            — lowering that will show more.
          </p>
        )}
        {minScore > 0 && (
          <div className="dsh-empty-acts">
            <button type="button" className="dsh-btn dsh-btn-go" onClick={() => setMinScore(0)}>
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
            className="dsh-btn dsh-btn-go"
            onClick={() => setStatusFilter('all')}
          >
            Show all {jobs.length}
          </button>
        </div>
      </div>
    )
  }

  // ---- the list ----

  // Say so when the server capped the page. A list that silently stops at 300
  // of 1,724 is worse than one that admits it.
  const capped = matchTotal > jobs.length
  let listRegion: ReactNode
  if (loading) {
    listRegion = <DashSkeleton rows={career ? 5 : 9} />
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
      // The stagger is CSS, capped at the first dozen rows by --i. Running a
      // JS animation over 140 memoised rows would cost more than the whole
      // redesign saves, and nothing below the fold is worth animating anyway.
      <ul className="dsh-list" data-stagger>
        {visibleJobs.map((job, i) => {
          const host = career ? hostOf(job.url) : null
          return (
            <li
              className="dsh-item"
              key={job.id}
              style={{ '--i': Math.min(i, 11) } as CSSProperties}
            >
              {career && (
                <p className="dsh-item-cap">
                  <span className="dsh-item-i u-num">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  {host && <span className="dsh-item-host">{host}</span>}
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
    <AnimatePresence initial={false}>
      {note && (
        <motion.div
          key="note"
          className="dsh-note"
          role="status"
          initial={still ? false : { opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
        >
          <span className="dsh-note-tick" aria-hidden="true">
            ✓
          </span>
          <div className="dsh-note-txt">
            <p className="dsh-note-t">{note.title}</p>
            <p className="dsh-note-l">{note.line}</p>
          </div>
          <span className="dsh-note-meta u-num">{note.meta}</span>
          <button
            type="button"
            className="dsh-note-x"
            onClick={() => setNote(null)}
            aria-label="Dismiss this message"
          >
            ×
          </button>
        </motion.div>
      )}
      {actionError && (
        <motion.div
          key="err"
          initial={still ? false : { opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
        >
          <DashError
            info={actionError.info}
            onRetry={actionError.retry}
            onDismiss={() => setActionError(null)}
          />
        </motion.div>
      )}
    </AnimatePresence>
  )

  const runPanel = (
    <DashRunPanel
      phase={phase}
      layout={career ? 'rail' : 'bar'}
      canRescore={jobs.length > 0 || poolForView > 0}
      rescore={rescore}
      onFetch={() => void handleFetch()}
      onRescore={() => void handleRescore()}
    />
  )

  // The count line lives in the filter bar so it travels with the controls that
  // change it, instead of sitting 6,000px above them.
  const countLine =
    !loading && jobs.length > 0 ? (
      <p className="dsh-count">
        <span className="dsh-num">{visibleJobs.length}</span>
        {statusFilter === 'all' ? (
          <>
            {' '}
            {visibleJobs.length === 1 ? 'role' : 'roles'}
            {minScore > 0 && (
              <>
                {' above '}
                <span className="dsh-num">{minScore}</span>
              </>
            )}
          </>
        ) : (
          <>
            {' of '}
            <span className="dsh-num">{jobs.length}</span> ·{' '}
            {STATUS_LABELS[statusFilter].toLowerCase()}
          </>
        )}
        {freshCount > 0 && statusFilter === 'all' && (
          <>
            {' · '}
            <span className="dsh-num">{freshCount}</span> this week
          </>
        )}
      </p>
    ) : null

  const controls = (
    <section className="dsh-console" aria-label="Filters">
      <div className="dsh-console-in">
        {filters}
        {countLine}
      </div>
      {capped && (
        <p className="dsh-capped" role="status">
          Showing <span className="dsh-num">{jobs.length}</span> of{' '}
          <span className="dsh-num">{matchTotal}</span> matches — raise the score
          floor to narrow it.
        </p>
      )}
    </section>
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
            <h2 className="dsh-h1">Scraped off company career pages</h2>
            <p className="dsh-lede">
              Read straight off company career sites that publish no API, so
              they exist nowhere else we can reach. A handful every few hours,
              not hundreds — worth reading properly.
            </p>
          </div>
          <div className="dsh-head-run">
            {runPanel}
            {phase === 'idle' && (
              <p className="dsh-fine">
                Career pages are only re-read every few hours, so a fetch will
                not always change this list.
              </p>
            )}
          </div>
        </header>

        {controls}
        {feedback}

        <main className="dsh-main" id={listId}>
          {listRegion}
        </main>

        {/* Kept, but demoted. It is a good argument for the dashboard and worth
            reading once; it is not worth a third of the screen every morning. */}
        <details className="dsh-note-fold">
          <summary>Why these are worth the time</summary>
          <dl className="dsh-why-list">
            <div>
              <dt>Barely contested</dt>
              <dd>
                Many never reach an aggregator at all. The ones that do land there
                days later, behind hundreds of applications.
              </dd>
            </div>
            <div>
              <dt>As current as it gets</dt>
              <dd>
                Read off the company’s own page, so nothing here is a stale relist
                from a third party.
              </dd>
            </div>
            <div>
              <dt>Few enough to read</dt>
              <dd>
                A handful, not hundreds. Open each one, read the verdict, and write
                a note you would actually send.
              </dd>
            </div>
          </dl>
        </details>
      </div>
    )
  }

  // ------------------------------------------------------------ job boards
  return (
    <div className="dsh dsh-boards">
      <header className="dsh-head">
        <div className="dsh-head-txt">
          <p className="dsh-eyebrow">API sources</p>
          <h2 className="dsh-h1">Everything pulled through an API</h2>
          <p className="dsh-lede">
            Company ATS boards — Greenhouse, Lever, Ashby — plus aggregators
            everyone else is reading too. Volume is the point: set a floor, work
            down from the top, move quickly.
          </p>
        </div>

        <div className="dsh-head-run">
          {runPanel}
          <div className="dsh-readout">
            <div className="dsh-stats">
              <div className="dsh-stat is-lead">
                <span className={`dsh-stat-v u-num${loading ? ' is-wait' : ''}`}>
                  {loading ? '—' : jobs.length}
                </span>
                <span className="dsh-stat-k">
                  {minScore === 0 ? 'matches' : `at ${minScore}+`}
                </span>
              </div>
              <div className="dsh-stat">
                <span className={`dsh-stat-v u-num${loading ? ' is-wait' : ''}`}>
                  {loading ? '—' : visibleJobs.length}
                </span>
                <span className="dsh-stat-k">showing</span>
              </div>
              <div className="dsh-stat">
                <span className={`dsh-stat-v u-num${loading ? ' is-wait' : ''}`}>
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
                      className={`dsh-mix-seg st-${s}`}
                      style={{ flexGrow: counts[s] }}
                    />
                  ) : null,
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      {boardSources.length > 0 && (
        <p className="dsh-legend">
          <span className="dsh-legend-k">In the pool</span>
          {boardSources.map((s) => (
            <span className="dsh-legend-i" key={s.name}>
              {s.name}
              <span className="dsh-legend-n u-num">{s.count}</span>
            </span>
          ))}
        </p>
      )}

      {controls}
      {feedback}

      <main className="dsh-main" id={listId}>
        {listRegion}
      </main>
    </div>
  )
}
