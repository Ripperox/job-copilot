import { memo, useEffect, useId, useState, useRef } from 'react'
import type { CSSProperties } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { JobStatus, Outreach, ScoredJob } from '../api'
import { JOB_STATUSES, generateOutreach, getOutreach, patchJob } from '../api'
import { formatSalary } from '../lib/format'
import '../styles/jobcard.css'

// A role is a ROW, not a card.
//
// The previous version was a 500px panel with the status control, a notes
// textarea and three buttons permanently open. That is a detail view, and
// rendering 140 of them turned a morning's triage into a 36,000px scroll. What
// you actually do with a board listing is decide, in about two seconds,
// whether it is worth opening — so the row carries exactly what that decision
// needs (score, title, company, verdict, place, pay, freshness, state) and
// everything else waits behind a disclosure.
//
// Nothing was removed. Every control that used to be on the card is inside the
// body, one click away, with the same handlers and the same requests.

// The score gets its own hue channel (`--sc`) rather than borrowing a status
// colour — how well a job fits and where it sits in the pipeline are different
// questions. Same thresholds as before.
function scoreBand(score: number | null): 'hi' | 'mid' | 'lo' | 'none' {
  if (score == null) return 'none'
  if (score >= 80) return 'hi'
  if (score >= 50) return 'mid'
  return 'lo'
}

const STATUS_LABELS: Record<JobStatus, string> = {
  new: 'New',
  outreach: 'Outreach',
  applied: 'Applied',
  interview: 'Interview',
  rejected: 'Rejected',
}

// "12 Jul" — compact, null-safe for bad input.
function shortDate(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}

// "14:32 · 12 Jul" — the draft's generation stamp.
function stamp(iso: string): string | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const time = d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  })
  return `${time} · ${shortDate(iso)}`
}

/**
 * Freshness in one glance-sized token.
 *
 * A row has room for about four characters here, and what matters when you are
 * working down a queue is how stale a posting is, not which Tuesday it landed.
 * "2d" answers that; the full date stays in the title attribute and in the
 * expanded body for anyone who wants it.
 */
function freshness(iso: string | null): { text: string; fresh: boolean } | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  const days = Math.floor((Date.now() - t) / 86_400_000)
  if (days < 0) return null
  if (days === 0) return { text: 'today', fresh: true }
  if (days < 7) return { text: `${days}d`, fresh: true }
  if (days < 31) return { text: `${Math.floor(days / 7)}w`, fresh: days <= 7 }
  return { text: `${Math.floor(days / 30)}mo`, fresh: false }
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <button
      className={`jc-copy${copied ? ' jc-copy-on' : ''}`}
      onClick={copy}
      type="button"
      aria-label={`Copy ${label}`}
      aria-live="polite"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

function ErrorLine({ message }: { message: string }) {
  return (
    <p className="jc-err" role="alert">
      {message}
    </p>
  )
}

function JobCard({
  job,
  onUpdated,
  onDismissed,
}: {
  job: ScoredJob
  onUpdated: (job: ScoredJob) => void
  onDismissed: (id: string) => void
}) {
  const [status, setStatus] = useState<JobStatus>(job.status)
  const [statusBusy, setStatusBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [notes, setNotes] = useState(job.notes)
  const [savedNotes, setSavedNotes] = useState(job.notes)
  const [notesSaved, setNotesSaved] = useState(false)
  const [notesSaving, setNotesSaving] = useState(false)

  const [dismissing, setDismissing] = useState(false)

  const [outreach, setOutreach] = useState<Outreach | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [outreachError, setOutreachError] = useState<string | null>(null)
  const [referral, setReferral] = useState('')
  const [note, setNote] = useState('')

  // Whether the row is showing its working area. A row with a saved draft opens
  // itself, which is what the old card did when it found one cached — the draft
  // has always been visible without a click, and that has not changed.
  const [open, setOpen] = useState(false)

  const uid = useId()
  const still = useReducedMotion()

  // Look for a saved draft the FIRST time the row is opened — not on mount.
  //
  // On mount this fired once per row: a load of the boards list issued ~140
  // /outreach requests, measured at 149 of 165 total requests on one page load.
  // Against a free-tier backend that alone made the list feel slow, and it did
  // it to fetch drafts for rows the user never opens.
  //
  // The cost of moving it: a row with an existing draft no longer springs open
  // by itself. That was only ever visible after 140 requests had landed, and a
  // dense list of self-opening rows would be worse than the click.
  const lookedForDraft = useRef(false)
  useEffect(() => {
    if (!open || lookedForDraft.current) return
    lookedForDraft.current = true
    let active = true
    getOutreach(job.id)
      .then((cached) => {
        if (active && cached) {
          applyOutreach(cached)
          setPanelOpen(true)
        }
      })
      .catch(() => {
        // A missing cache is not an error worth surfacing.
      })
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, job.id])

  // A different job in the same recycled row must look for its own draft.
  useEffect(() => {
    lookedForDraft.current = false
  }, [job.id])

  function applyOutreach(o: Outreach) {
    setOutreach(o)
    setReferral(o.referralMessage)
    setNote(o.applicationNote)
  }

  async function changeStatus(next: JobStatus) {
    if (next === status || statusBusy) return
    setStatusBusy(true)
    setError(null)
    const prev = status
    setStatus(next) // optimistic
    try {
      const updated = await patchJob(job.id, { status: next })
      setStatus(updated.status)
      onUpdated(updated)
    } catch (err: unknown) {
      setStatus(prev) // roll back
      setError(err instanceof Error ? err.message : 'Failed to update status')
    } finally {
      setStatusBusy(false)
    }
  }

  async function saveNotes() {
    if (notes === savedNotes) return
    setNotesSaving(true)
    setError(null)
    try {
      const updated = await patchJob(job.id, { notes })
      setSavedNotes(updated.notes)
      setNotes(updated.notes)
      onUpdated(updated)
      setNotesSaved(true)
      window.setTimeout(() => setNotesSaved(false), 1800)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save notes')
    } finally {
      setNotesSaving(false)
    }
  }

  async function handleDismiss() {
    setDismissing(true)
    setError(null)
    try {
      await patchJob(job.id, { dismissed: true })
      onDismissed(job.id)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to dismiss')
      setDismissing(false)
    }
  }

  async function runOutreach(regenerate: boolean) {
    setGenerating(true)
    setOutreachError(null)
    setPanelOpen(true)
    setOpen(true)
    try {
      const result = await generateOutreach(job.id, regenerate)
      applyOutreach(result)
    } catch (err: unknown) {
      setOutreachError(
        err instanceof Error ? err.message : 'Failed to draft outreach',
      )
    } finally {
      setGenerating(false)
    }
  }

  async function handleDraft() {
    // If we already have a draft, just reveal it; generation stays explicit.
    if (outreach) {
      setPanelOpen(true)
      return
    }
    await runOutreach(false)
  }

  const band = scoreBand(job.score)
  const filled =
    job.score == null ? 0 : Math.max(0, Math.min(100, Math.round(job.score)))
  const posted = shortDate(job.postedAt)
  const fresh = freshness(job.postedAt ?? job.createdAt)
  const generatedAt = outreach ? stamp(outreach.generatedAt) : null
  const notesState = notesSaving ? 'Saving…' : notesSaved ? 'Saved' : ''
  const pay = job.salary ? formatSalary(job.salary) : null
  const bodyId = `jcb-${uid}`

  return (
    <article
      className={`jc st-${status} jc-s-${band}`}
      data-open={open || undefined}
      data-drafted={outreach ? '' : undefined}
    >
      {/* ---------------------------------------------------------------- row
          Everything you need to decide whether to open it. One tab stop for
          the disclosure, then the two actions you take without opening. */}
      <div className="jc-row">
        <button
          type="button"
          className="jc-toggle"
          aria-expanded={open}
          /* Only while it exists: the body is unmounted when collapsed, and
             aria-controls pointing at an id that is not in the document is an
             invalid reference rather than a helpful one. */
          aria-controls={open ? bodyId : undefined}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="jc-score" title={job.score == null ? 'Not scored yet' : `Scores ${job.score} out of 100 — 80+ = apply, 50-79 = partial, <50 = wrong level/stack`}>
            <span className="jc-score-n u-num">
              {job.score == null ? '—' : job.score}
            </span>
            <span className="jc-score-meter" aria-hidden="true">
              <i style={{ '--fill': `${filled}%` } as CSSProperties} />
            </span>
          </span>

          {/* Three siblings on a grid rather than two nested spans, so a narrow
              list can drop the company onto the facts line and give the title
              the whole width. Truncating a title to "Full Stack Engineer
              (Node/Re…" next to a company truncated to "N…" helps nobody. */}
          <span className="jc-main">
            <span className="jc-title">{job.title}</span>
            <span className="jc-org">{job.company}</span>
            <span className="jc-facts">
              {job.location && <span className="jc-fact">{job.location}</span>}
              {pay && <span className="jc-fact jc-fact-pay u-num">{pay}</span>}
              <span className="jc-fact jc-fact-src">{job.source}</span>
              {job.cvVariant && (
                <span className="jc-fact jc-fact-cv">
                  <span className="u-tag">CV</span>
                  {job.cvVariant}
                </span>
              )}
            </span>
          </span>

          {/* The verdict, on the row, at reading size. This is the whole point
              of paying for a model to read the posting — it should not be
              hidden behind a click. Clamped to two lines; the full text is in
              the body. An empty column would read as a rendering fault, so the
              two cases where there is no verdict say which one it is. */}
          <span className={`jc-verdict${job.reason ? '' : ' is-none'}`}>
            {job.reason ??
              (job.score == null
                ? 'Not scored yet — save your résumé and press Re-score.'
                : 'Scored by keyword match (no model key) — add a scoring key for written reasons.')}
          </span>

          <span className="jc-tail">
            <span className="jc-state">
              <i className="u-dot" aria-hidden="true" />
              <span className="jc-state-t">{STATUS_LABELS[status]}</span>
            </span>
            {fresh && (
              <span
                className={`jc-when u-num${fresh.fresh ? ' is-fresh' : ''}`}
                title={posted ? `Posted ${posted}` : undefined}
              >
                {fresh.text}
              </span>
            )}
          </span>

          <span className="jc-chev" aria-hidden="true">
            <svg viewBox="0 0 16 16" width="12" height="12" focusable="false">
              <path
                d="M4 6.2 8 10.2l4-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </button>

        <span className="jc-quick">
          <a
            className="jc-quick-btn"
            href={job.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open the ${job.title} posting at ${job.company} in a new tab`}
            title="Open posting"
          >
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
              <path
                d="M6.2 3.2h6.6v6.6M12.8 3.2 6 10M10.4 12.8H3.2V5.6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </a>
          <button
            type="button"
            className="jc-quick-btn jc-quick-x"
            onClick={handleDismiss}
            disabled={dismissing}
            aria-label={`Dismiss ${job.title} at ${job.company}`}
            title="Dismiss"
          >
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
              <path
                d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </span>
      </div>

      {/* --------------------------------------------------------------- body
          Same controls, same handlers, same requests as the old always-open
          card — just gated behind the decision to work on this one. */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={bodyId}
            className="jc-body"
            initial={still ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={still ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{
              height: { duration: 0.26, ease: [0.32, 0.72, 0, 1] },
              opacity: { duration: 0.16 },
            }}
            style={{ overflow: 'hidden' }}
          >
            <div className="jc-body-in">
              {job.reason && <p className="jc-why">{job.reason}</p>}

              <p className="jc-prov">
                {job.source}
                {posted && (
                  <>
                    {' · posted '}
                    <span className="u-num">{posted}</span>
                  </>
                )}
                {job.score != null && (
                  <>
                    {' · scores '}
                    <span className="u-num">{job.score}</span>
                    <span className="jc-prov-max">/100</span>
                  </>
                )}
              </p>

              <div className="jc-row-ctl">
                <span className="u-label jc-row-cap" id={`st-${uid}`}>
                  Status
                </span>
                <div className="jc-seg" role="group" aria-labelledby={`st-${uid}`}>
                  {JOB_STATUSES.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={`jc-seg-btn st-${s}`}
                      onClick={() => changeStatus(s)}
                      disabled={statusBusy}
                      aria-pressed={s === status}
                    >
                      {STATUS_LABELS[s]}
                    </button>
                  ))}
                </div>
              </div>

              <div className="jc-notes">
                <div className="jc-notes-head">
                  <label className="u-label" htmlFor={`notes-${uid}`}>
                    Notes
                  </label>
                  <span
                    className={`jc-notes-state${notesSaved && !notesSaving ? ' jc-notes-state-ok' : ''}`}
                    aria-live="polite"
                  >
                    {notesState}
                  </span>
                </div>
                <textarea
                  id={`notes-${uid}`}
                  className="jc-input"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  onBlur={saveNotes}
                  rows={2}
                  placeholder="Add a note (saved when you click away)…"
                />
              </div>

              <div className="jc-acts">
                <button
                  className="jc-btn jc-btn-go"
                  onClick={handleDraft}
                  disabled={generating}
                  type="button"
                >
                  {generating ? 'Drafting…' : outreach ? 'Outreach draft' : 'Draft outreach'}
                </button>
                <a
                  className="jc-btn"
                  href={job.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open posting ↗
                </a>
                <button
                  className="jc-btn jc-btn-quiet"
                  onClick={handleDismiss}
                  disabled={dismissing}
                  type="button"
                >
                  {dismissing ? 'Dismissing…' : 'Dismiss'}
                </button>
              </div>

              {error && (
                <div className="jc-err-slot">
                  <ErrorLine message={error} />
                </div>
              )}

              {panelOpen && (
                <section className="jc-out u-rise" aria-label="Outreach draft">
                  {generating && !outreach ? (
                    <p className="jc-loading">
                      <span className="live-dot" aria-hidden="true" />
                      Drafting outreach…
                    </p>
                  ) : outreachError && !outreach ? (
                    <ErrorLine message={outreachError} />
                  ) : outreach ? (
                    <>
                      <div className="jc-out-head">
                        <h4 className="jc-out-title">Outreach draft</h4>
                        {outreach.cvVariant && (
                          <span className="jc-chip">
                            <span className="jc-chip-key">CV</span>
                            {outreach.cvVariant}
                          </span>
                        )}
                        <span className="jc-out-right">
                          {generatedAt && (
                            <span className="jc-out-time">
                              Written <span className="u-num">{generatedAt}</span>
                            </span>
                          )}
                          <button
                            className="jc-btn"
                            onClick={() => runOutreach(true)}
                            disabled={generating}
                            type="button"
                          >
                            {generating ? 'Regenerating…' : 'Regenerate'}
                          </button>
                        </span>
                      </div>

                      {outreachError && <ErrorLine message={outreachError} />}

                      <div className="jc-draft">
                        <div className="jc-draft-head">
                          <label className="jc-draft-cap" htmlFor={`referral-${uid}`}>
                            Referral message
                          </label>
                          <span className="jc-draft-count">
                            <span className="u-num">{referral.length}</span> characters
                          </span>
                          <CopyButton text={referral} label="referral message" />
                        </div>
                        <textarea
                          id={`referral-${uid}`}
                          className="jc-draft-body"
                          value={referral}
                          onChange={(e) => setReferral(e.target.value)}
                          rows={5}
                        />
                      </div>

                      <div className="jc-draft">
                        <div className="jc-draft-head">
                          <label className="jc-draft-cap" htmlFor={`note-${uid}`}>
                            Application note
                          </label>
                          <span className="jc-draft-count">
                            <span className="u-num">{note.length}</span> characters
                          </span>
                          <CopyButton text={note} label="application note" />
                        </div>
                        <textarea
                          id={`note-${uid}`}
                          className="jc-draft-body"
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                          rows={5}
                        />
                      </div>

                      {outreach.targets.length > 0 && (
                        <div className="jc-draft jc-draft-list">
                          <div className="jc-draft-head">
                            <span className="jc-draft-cap" id={`targets-${uid}`}>
                              Who to contact
                            </span>
                            <span className="jc-draft-count">
                              <span className="u-num">{outreach.targets.length}</span>{' '}
                              people
                            </span>
                          </div>
                          <ul className="jc-tg" aria-labelledby={`targets-${uid}`}>
                            {outreach.targets.map((t, i) => (
                              <li className="jc-tg-row" key={`${t.searchUrl}-${i}`}>
                                <span className="jc-tg-t">{t.title}</span>
                                <a
                                  className="jc-tg-go"
                                  href={t.searchUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  aria-label={`Find ${t.title} on LinkedIn`}
                                >
                                  Find on LinkedIn ↗
                                </a>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </>
                  ) : null}
                </section>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* A failed dismiss from the row has to say so even while collapsed. */}
      {error && !open && (
        <div className="jc-err-slot jc-err-slot-row">
          <ErrorLine message={error} />
        </div>
      )}
    </article>
  )
}

// Memoised: the dashboard re-renders on every filter change, status update and
// poll, and re-rendering 300+ rows to change one of them is the difference
// between the list feeling instant and feeling stuck. Props are stable —
// handlers are useCallback'd in Dashboard — so the default shallow compare is
// enough.
export default memo(JobCard)
