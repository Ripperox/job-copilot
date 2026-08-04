import { useEffect, useId, useState } from 'react'
import type { JobStatus, Outreach, ScoredJob } from '../api'
import { JOB_STATUSES, generateOutreach, getOutreach, patchJob } from '../api'
import { formatSalary } from '../lib/format'
import '../styles/jobcard.css'

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

export default function JobCard({
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

  const uid = useId()

  // Cheaply load a cached draft on mount (does not generate).
  useEffect(() => {
    let active = true
    getOutreach(job.id)
      .then((cached) => {
        if (active && cached) {
          applyOutreach(cached)
          setPanelOpen(true)
        }
      })
      .catch(() => {
        // A missing cache is not an error worth surfacing on load.
      })
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const generatedAt = outreach ? stamp(outreach.generatedAt) : null
  const notesState = notesSaving ? 'Saving…' : notesSaved ? 'Saved' : ''

  return (
    <article className={`jc st-${status} jc-s-${band}`}>
      {/* 1. What the job is. */}
      <div className="jc-head">
        <div className="jc-headline">
          <h3 className="jc-title">{job.title}</h3>
          <p className="jc-org">{job.company}</p>

          {(job.location || job.salary || job.cvVariant) && (
            <div className="jc-facts">
              {job.location && <span className="jc-fact">{job.location}</span>}
              {job.salary && (
                <span className="jc-fact jc-fact-pay">{formatSalary(job.salary)}</span>
              )}
              {job.cvVariant && (
                <span className="jc-fact">
                  <span className="jc-fact-key">CV</span>
                  {job.cvVariant}
                </span>
              )}
            </div>
          )}

          <p className="jc-prov">
            {job.source}
            {posted && (
              <>
                {' · posted '}
                <span className="u-num">{posted}</span>
              </>
            )}
          </p>
        </div>

        <span className="u-pill jc-state">{STATUS_LABELS[status]}</span>
      </div>

      {/* 2. How well it fits, and why. */}
      <div className="jc-fit">
        {job.score == null ? (
          <p className="jc-fit-none">Not scored yet</p>
        ) : (
          <>
            <div className="jc-fit-row">
              <span className="jc-fit-cap">Match</span>
              <span className="jc-fit-read">
                <span className="jc-fit-val">{job.score}</span>
                <span className="jc-fit-max" aria-hidden="true">
                  /100
                </span>
              </span>
            </div>
            <span className="jc-bar" aria-hidden="true">
              <span className="jc-bar-fill" style={{ width: `${filled}%` }} />
            </span>
          </>
        )}
        {job.reason && <p className="jc-why">{job.reason}</p>}
      </div>

      {/* 3. What you can do about it. */}
      <div className="jc-row">
        <span className="u-label jc-row-cap">Status</span>
        <div className="jc-seg" role="group" aria-label="Set status">
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
    </article>
  )
}
