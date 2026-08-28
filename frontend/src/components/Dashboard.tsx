import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { JobStatus, ScoredJob, SourceInfo, RescoreProgress, RunPhase } from '../api'
import { JOB_STATUSES, UnauthorizedError, fetchJobs, getJobs, getProfile, getRescoreStatus, getSources, startRescore } from '../api'
import JobCard from './JobCard'
import DashError, { describeError } from './DashError'
import type { DashErrorInfo } from './DashError'
import DashRunPanel, { formatElapsed } from './DashRunPanel'
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

const SCORE_LEGEND = {
  0: 'Show every role, scored or not.',
  50: '50+ = partial match: right level but different primary stack or weaker overlap.',
  60: '60+ = stronger partial: related stack, good experience overlap.',
  70: '70+ = very close: same stack family, right level, minor gaps.',
  80: '80+ = APPLY: backend OR full-stack at your level with a related stack.',
}

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

// Locations arrive as free text ("Bengaluru, India", "Remote", "Amsterdam",
// "NL", "Netherlands"). A filter must be forgiving: "NL" must match "Netherlands"
// and "Amsterdam, NL", and exact spelling should never matter. We alias the
// common forms so one chip ("Netherlands") catches every spelling of it.
const ALIASES: Record<string, string> = {
  netherlands: 'nl',
  holland: 'nl',
  nl: 'nl',
  'the netherlands': 'nl',
  'united states': 'us',
  usa: 'us',
  'u.s.': 'us',
  'united kingdom': 'uk',
  england: 'uk',
  'u.k.': 'uk',
  germany: 'de',
  france: 'fr',
  india: 'in',
  bengaluru: 'bengaluru',
  bangalore: 'bengaluru',
  remote: 'remote',
}

// Does a job's location match the active filter? Empty filter matches everything.
// Every term in the query must appear (after aliasing), so "Netherlands" and
// "Amsterdam" both match "Amsterdam, Netherlands" but a bare "a" still matches
// nothing, avoiding the classic substring-prefix misfire.
function matchesLocation(location: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const hay = (location || '').toLowerCase()
  const norm = (t: string): string[] => {
    const aliased = ALIASES[t] ?? t
    return [t, aliased].filter(Boolean)
  }
  return q.split(/\s+/).every((term) => {
    const forms = norm(term)
    return forms.some((f) => hay.includes(f))
  })
}

export default function Dashboard({
  view,
  onUnauthorized,
  onSwitchView,
  globalPhase,
  setGlobalPhase,
}: {
  view: 'career-pages' | 'job-boards'
  onUnauthorized?: () => void
  /** Jump to the other dashboard — used by the empty state's cross-reference. */
  onSwitchView?: (view: 'career-pages' | 'job-boards' | 'profile') => void
  /** Global phase from App — persists across tab switches. */
  globalPhase: RunPhase
  setGlobalPhase: (phase: RunPhase) => void
}) {
  const career = view === 'career-pages'
  const uid = useId()
  const still = useReducedMotion()

  const [minScore, setMinScore] = useState(50)
  const [jobs, setJobs] = useState<ScoredJob[]>([])
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [locationFilter, setLocationFilter] = useState('')
  const [locationSearch, setLocationSearch] = useState('')
  const [locationMenuOpen, setLocationMenuOpen] = useState(false)
  const [statusMenuOpen, setStatusMenuOpen] = useState(false)
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<DashErrorInfo | null>(null)
  const [actionError, setActionError] = useState<{
    info: DashErrorInfo
    retry: () => void
  } | null>(null)
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

  // Use global phase — no local phase state needed
  const phase = globalPhase
  const setPhase = setGlobalPhase

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
    setLocationFilter('')
    setLocationSearch('')
    setStatusMenuOpen(false)
    setLocationMenuOpen(false)
    setMoreFiltersOpen(false)
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

  // Click outside to close dropdowns
  useEffect(() => {
    function onClick(e: MouseEvent) {
      const target = e.target as HTMLElement
      if (statusMenuOpen && !target.closest('.dsh-dropdown')) setStatusMenuOpen(false)
      if (locationMenuOpen && !target.closest('.dsh-dropdown')) setLocationMenuOpen(false)
      if (moreFiltersOpen && !target.closest('.dsh-filter-group')) setMoreFiltersOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [statusMenuOpen, locationMenuOpen, moreFiltersOpen])

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
    () =>
      jobs.filter(
        (j) =>
          (statusFilter === 'all' || j.status === statusFilter) &&
          matchesLocation(j.location, locationFilter),
      ),
    [jobs, statusFilter, locationFilter],
  )

  // Quick location chips derived from what is actually on this dashboard, so a
  // user can filter to "Remote" or wherever without spelunking the queue.
  const locationChips = useMemo(() => {
    const want = ['Remote', 'Netherlands', 'Bengaluru', 'India', 'Mumbai', 'Hyderabad', 'Delhi', 'New York', 'London', 'Berlin', 'Singapore', 'Dubai']
    return want.filter((w) => jobs.some((j) => matchesLocation(j.location, w)))
  }, [jobs])

  const filteredLocationChips = useMemo(() => {
    if (!locationSearch.trim()) return locationChips
    const q = locationSearch.toLowerCase()
    return locationChips.filter((w) => w.toLowerCase().includes(q))
  }, [locationChips, locationSearch])

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
    <div className="dsh-filter-bar" role="search" aria-label="Job filters">
      {/* Score — pill group (primary filter, always visible) */}
      <div className="dsh-filter-group">
        <div className="dsh-pill-group" role="group" aria-label="Minimum score">
          {SCORE_OPTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className={`dsh-pill${s === minScore ? ' is-active' : ''}`}
              aria-pressed={s === minScore}
              title={SCORE_LEGEND[s as keyof typeof SCORE_LEGEND] ?? `Show roles scoring ${s} or higher.`}
              onClick={() => setMinScore(s)}
            >
              {s === 0 ? 'Any' : <span className="dsh-pill-num">{s}+</span>}
            </button>
          ))}
        </div>
      </div>

      {/* Status — dropdown button (Indeed/ZipRecruiter pattern) */}
      <div className="dsh-filter-group">
        <div className="dsh-dropdown" role="combobox" aria-label="Status filter" aria-expanded={statusMenuOpen} aria-controls={`${uid}-status-menu`}>
          <button
            type="button"
            className={`dsh-dropdown-trigger${statusFilter !== 'all' ? ' has-value' : ''}`}
            onClick={() => setStatusMenuOpen(!statusMenuOpen)}
            aria-haspopup="listbox"
            aria-controls={`${uid}-status-menu`}
          >
            <span className="dsh-dropdown-label">
              {statusFilter === 'all' ? 'All Status' : STATUS_LABELS[statusFilter]}
            </span>
            <span className="dsh-dropdown-count">{statusFilter === 'all' ? jobs.length : counts[statusFilter]}</span>
            <svg className="dsh-dropdown-caret" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 6.2 8 10.2l4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          {statusMenuOpen && (
            <ul id={`${uid}-status-menu`} className="dsh-dropdown-menu" role="listbox" aria-label="Status options">
              <li role="option" aria-selected={statusFilter === 'all'} className={statusFilter === 'all' ? 'is-selected' : ''} onClick={() => { setStatusFilter('all'); setStatusMenuOpen(false); }}>
                <span>All Status</span>
                <span className="dsh-dropdown-opt-count">{jobs.length}</span>
              </li>
              {statusChoices.map((s) => (
                <li key={s} role="option" aria-selected={statusFilter === s} className={statusFilter === s ? 'is-selected' : ''} onClick={() => { setStatusFilter(s); setStatusMenuOpen(false); }}>
                  <span className="dsh-opt-dot" style={{ '--dot-color': `var(--st-${s})` } as React.CSSProperties} aria-hidden="true" />
                  <span>{STATUS_LABELS[s]}</span>
                  <span className="dsh-dropdown-opt-count">{counts[s]}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Location — pill with popover (LinkedIn pattern) */}
      <div className="dsh-filter-group">
        <div className="dsh-dropdown dsh-location-dropdown" role="combobox" aria-label="Location filter" aria-expanded={locationMenuOpen} aria-controls={`${uid}-location-menu`}>
          <button
            type="button"
            className={`dsh-dropdown-trigger dsh-loc-trigger${locationFilter ? ' has-value' : ''}`}
            onClick={() => setLocationMenuOpen(!locationMenuOpen)}
            aria-haspopup="listbox"
            aria-controls={`${uid}-location-menu`}
          >
            <svg className="dsh-loc-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M8 1a7 7 0 0 1 7 7c0 5.25-7 13-7 13S1 13.25 1 8a7 7 0 0 1 7-7z" fill="currentColor"/></svg>
            <span className="dsh-dropdown-label">{locationFilter || 'Location'}</span>
            {locationFilter && (
              <button type="button" className="dsh-dropdown-clear" aria-label="Clear location" onClick={(e) => { e.stopPropagation(); setLocationFilter(''); }}>×</button>
            )}
            <svg className="dsh-dropdown-caret" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 6.2 8 10.2l4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          {locationMenuOpen && (
            <div id={`${uid}-location-menu`} className="dsh-dropdown-menu dsh-loc-menu" role="listbox" aria-label="Location options">
              <div className="dsh-loc-search">
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M7 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm5.58-1.42a4.5 4.5 0 1 1-6.36-6.36" fill="none" stroke="currentColor" strokeWidth="1.5"/></svg>
                <input
                  type="text"
                  placeholder="Search locations..."
                  value={locationSearch}
                  onChange={(e) => setLocationSearch(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
              <div className="dsh-loc-suggestions" role="listbox">
                {filteredLocationChips.map((w) => (
                  <button
                    key={w}
                    type="button"
                    role="option"
                    aria-selected={locationFilter.trim() === w}
                    className={`dsh-loc-opt${locationFilter.trim() === w ? ' is-selected' : ''}`}
                    onClick={() => { setLocationFilter(locationFilter.trim() === w ? '' : w); setLocationMenuOpen(false); }}
                  >
                    <span className="dsh-loc-opt-icon" aria-hidden="true">⌖</span>
                    <span>{w}</span>
                  </button>
                ))}
                {locationFilter && !filteredLocationChips.includes(locationFilter) && (
                  <button
                    type="button"
                    role="option"
                    className="dsh-loc-opt is-custom"
                    onClick={() => { setLocationMenuOpen(false); }}
                  >
                    <span className="dsh-loc-opt-icon" aria-hidden="true">⌖</span>
                    <span>Use "{locationFilter}"</span>
                  </button>
                )}
              </div>
              {locationFilter && (
                <button type="button" className="dsh-loc-clear-all" onClick={() => { setLocationFilter(''); setLocationMenuOpen(false); }}>Clear location filter</button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* More Filters button (progressive disclosure) */}
      <div className="dsh-filter-group">
        <button
          type="button"
          className="dsh-more-filters"
          onClick={() => setMoreFiltersOpen(!moreFiltersOpen)}
          aria-expanded={moreFiltersOpen}
          aria-controls={`${uid}-more-filters`}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 5h10M3 8h10M3 11h10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          More Filters
        </button>
      </div>
    </div>
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
          <h3 className="dsh-empty-t">Career pages not configured</h3>
          <p className="dsh-empty-b">
            This dashboard needs a scraping provider (Firecrawl or Tavily) and a list of career-page URLs on the server.
          </p>
          {onSwitchView && (
            <div className="dsh-empty-acts">
              <button className="dsh-btn dsh-btn-primary" onClick={() => onSwitchView('job-boards')}>
                Switch to Job Boards
              </button>
            </div>
          )}
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
            <h3 className="dsh-empty-t">Add your résumé to see match scores</h3>
            <p className="dsh-empty-b">
              <span className="dsh-num">{poolForView.toLocaleString()}</span> {career ? 'career-page' : 'API'} roles waiting. Add your résumé and they get scored.
            </p>
            <div className="dsh-empty-acts">
              {onSwitchView && (
                <button className="dsh-btn dsh-btn-primary" onClick={() => onSwitchView('profile')}>
                  Add résumé in Profile
                </button>
              )}
              <button className="dsh-btn dsh-btn-go" onClick={() => setMinScore(0)}>
                Show all {poolForView} without scoring
              </button>
            </div>
          </div>
        )
      }

      const other = career ? 'Job Boards' : 'Career Pages'
      const otherLabel = career ? 'job-boards' : 'career-pages'
      return (
        <div className="dsh-empty">
          <h3 className="dsh-empty-t">Nothing scores <span className="dsh-num">{minScore}</span>+</h3>
          <p className="dsh-empty-b">
            {poolForView === 1 ? 'One role' : `${poolForView} roles`} scored below <span className="dsh-num">{minScore}</span>.
          </p>
          {otherCount > 0 && (
            <p className="dsh-empty-b">
              <span className="dsh-num">{otherCount}</span> {otherCount === 1 ? 'role' : 'roles'} on <strong>{other}</strong> clear it.
            </p>
          )}
          <div className="dsh-empty-acts">
            {otherCount > 0 && onSwitchView && (
              <button className="dsh-btn dsh-btn-primary" onClick={() => onSwitchView(otherLabel)}>
                Go to {other} ({otherCount})
              </button>
            )}
            <button className="dsh-btn dsh-btn-go" onClick={() => setMinScore(0)}>
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
          <p className="dsh-empty-b">Career pages refresh every few hours. Run a fetch to check now.</p>
        </div>
      )
    }

    return (
      <div className="dsh-empty">
        <h3 className="dsh-empty-t">No board listings yet</h3>
        <p className="dsh-empty-b">ATS boards and aggregators. A fetch fills this up in about a minute.</p>
        {minScore > 0 && (
          <>
            <p className="dsh-empty-b">Filtering to <span className="dsh-num">{minScore}</span>+ — lowering shows more.</p>
            <div className="dsh-empty-acts">
              <button className="dsh-btn dsh-btn-go" onClick={() => setMinScore(0)}>Show every score</button>
            </div>
          </>
        )}
      </div>
    )
  }

  function emptyStatus(): ReactNode {
    const label = statusFilter === 'all' ? '' : STATUS_LABELS[statusFilter].toLowerCase()
    return (
      <div className="dsh-empty">
        <h3 className="dsh-empty-t">Nothing is marked {label}</h3>
        <p className="dsh-empty-b">
          {jobs.length === 1 ? 'Your one match is in a different status.' : `None of ${jobs.length} matches are in this status.`}
        </p>
        <div className="dsh-empty-acts">
          <button className="dsh-btn dsh-btn-go" onClick={() => setStatusFilter('all')}>Show all {jobs.length}</button>
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
  } else if (visibleJobs.length === 0 && locationFilter) {
    listRegion = (
      <div className="dsh-empty">
        <h3 className="dsh-empty-t">No matches in “{locationFilter}”</h3>
        <p className="dsh-empty-b">
          {jobs.length === 1 ? 'Your one match isn’t in that location.' : `None of ${jobs.length} matches have that location.`}
          Try “NL”, “Netherlands”, a city, or clear the filter.
        </p>
        <div className="dsh-empty-acts">
          <button className="dsh-btn dsh-btn-go" onClick={() => setLocationFilter('')}>Clear location filter</button>
        </div>
      </div>
    )
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
        {locationFilter && (
          <>
            {' · '}
            <span className="dsh-num">{visibleJobs.length}</span> in{' '}
            <span className="dsh-num">{locationFilter}</span>
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

  // Active filter chips row (LinkedIn/Indeed pattern)
  function ActiveFilterChips({
    minScore,
    statusFilter,
    locationFilter,
    counts,
    onClearScore,
    onClearStatus,
    onClearLocation,
  }: {
    minScore: number
    statusFilter: StatusFilter
    locationFilter: string
    counts: Record<JobStatus, number>
    onClearScore: () => void
    onClearStatus: () => void
    onClearLocation: () => void
  }) {
    const hasAny = minScore > 0 || statusFilter !== 'all' || locationFilter
    if (!hasAny) return null

    return (
      <div className="dsh-active-chips" role="status" aria-label="Active filters">
        {minScore > 0 && (
          <span className="dsh-chip" onClick={onClearScore}>
            <span>Score {minScore}+</span>
            <button type="button" className="dsh-chip-x" aria-label="Remove score filter">×</button>
          </span>
        )}
        {statusFilter !== 'all' && (
          <span className="dsh-chip" onClick={onClearStatus}>
            <span className="dsh-chip-dot" style={{ '--dot-color': `var(--st-${statusFilter})` } as React.CSSProperties} aria-hidden="true" />
            <span>{STATUS_LABELS[statusFilter]}</span>
            <span className="dsh-chip-count">{counts[statusFilter]}</span>
            <button type="button" className="dsh-chip-x" aria-label="Remove status filter">×</button>
          </span>
        )}
        {locationFilter && (
          <span className="dsh-chip" onClick={onClearLocation}>
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M8 1a7 7 0 0 1 7 7c0 5.25-7 13-7 13S1 13.25 1 8a7 7 0 0 1 7-7z" fill="currentColor"/></svg>
            <span>{locationFilter}</span>
            <button type="button" className="dsh-chip-x" aria-label="Remove location filter">×</button>
          </span>
        )}
        <button type="button" className="dsh-chip dsh-chip-clear" onClick={() => { onClearScore(); onClearStatus(); onClearLocation(); }}>Clear all</button>
      </div>
    )
  }

  const controls = (
    <section className="dsh-console" aria-label="Filters">
      <div className="dsh-console-in">
        {filters}
        {countLine}
      </div>
      <ActiveFilterChips
        minScore={minScore}
        statusFilter={statusFilter}
        locationFilter={locationFilter}
        counts={counts}
        onClearScore={() => setMinScore(0)}
        onClearStatus={() => setStatusFilter('all')}
        onClearLocation={() => setLocationFilter('')}
      />
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
            Career Pages
          </p>
          <h2 className="dsh-h1">Roles scraped from company career pages</h2>
          <p className="dsh-lede">Few, fresh, barely contested. Read each one properly.</p>
        </div>
        <div className="dsh-head-run">
          {runPanel}
          {phase === 'idle' && (
            <p className="dsh-fine">Career pages re-read every few hours — fetch may not change the list.</p>
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
          <p className="dsh-eyebrow">Job Boards</p>
          <h2 className="dsh-h1">Roles from ATS boards and aggregators</h2>
          <p className="dsh-lede">ATS boards and aggregators, all scored. Set a floor and work down.</p>
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
