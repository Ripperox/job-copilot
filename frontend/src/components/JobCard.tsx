import { useEffect, useState } from 'react'
import type { JobStatus, Outreach, ScoredJob } from '../api'
import { JOB_STATUSES, generateOutreach, getOutreach, patchJob } from '../api'

function scoreClass(score: number | null): string {
  if (score == null) return 'score-grey'
  if (score >= 80) return 'score-green'
  if (score >= 50) return 'score-amber'
  return 'score-grey'
}

const STATUS_LABELS: Record<JobStatus, string> = {
  new: 'New',
  outreach: 'Outreach',
  applied: 'Applied',
  interview: 'Interview',
  rejected: 'Rejected',
}

function CopyButton({ text }: { text: string }) {
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
    <button className="btn btn-outline btn-sm" onClick={copy} type="button">
      {copied ? 'Copied ✓' : 'Copy'}
    </button>
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

  return (
    <article className={`card job-card job-card-${status}`}>
      <div className="job-head">
        <div className={`score-badge ${scoreClass(job.score)}`}>
          <span className="score-num">{job.score == null ? '—' : job.score}</span>
          <span className="score-word">score</span>
        </div>
        <div className="job-title-block">
          <h3 className="job-title">{job.title}</h3>
          <div className="job-meta">
            <span className="job-company">{job.company}</span>
            {job.location && <span className="dot">·</span>}
            {job.location && <span>{job.location}</span>}
            {job.salary && <span className="dot">·</span>}
            {job.salary && <span className="job-salary">{job.salary}</span>}
          </div>
        </div>
        <span className={`status-tag status-${status}`}>
          {STATUS_LABELS[status]}
        </span>
      </div>

      {job.reason && <p className="job-reason">{job.reason}</p>}

      <div className="status-control" role="group" aria-label="Set status">
        {JOB_STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            className={`status-btn status-${s}${
              s === status ? ' status-btn-active' : ''
            }`}
            onClick={() => changeStatus(s)}
            disabled={statusBusy}
            aria-pressed={s === status}
          >
            {STATUS_LABELS[s]}
          </button>
        ))}
      </div>

      <div className="notes-field">
        <div className="notes-head">
          <span className="notes-label">Notes</span>
          {notesSaving ? (
            <span className="muted notes-status">Saving…</span>
          ) : notesSaved ? (
            <span className="notes-status notes-saved">Saved ✓</span>
          ) : null}
        </div>
        <textarea
          className="textarea notes-textarea"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={saveNotes}
          rows={2}
          placeholder="Add a note (saved on blur)…"
        />
      </div>

      <div className="job-foot">
        <div className="job-tags">
          {job.cvVariant && <span className="pill">CV: {job.cvVariant}</span>}
          <span className="pill pill-muted">{job.source}</span>
        </div>
        <div className="job-actions">
          <a
            className="btn btn-ghost"
            href={job.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open posting ↗
          </a>
          <button
            className="btn btn-outline"
            onClick={handleDraft}
            disabled={generating}
            type="button"
          >
            {generating
              ? 'Drafting…'
              : outreach
                ? 'Outreach'
                : 'Draft outreach'}
          </button>
          <button
            className="btn btn-ghost btn-dismiss"
            onClick={handleDismiss}
            disabled={dismissing}
            type="button"
          >
            {dismissing ? 'Dismissing…' : 'Dismiss'}
          </button>
        </div>
      </div>

      {error && <div className="banner banner-error banner-tight">{error}</div>}

      {panelOpen && (
        <div className="outreach">
          {generating && !outreach ? (
            <p className="muted outreach-loading">Drafting outreach…</p>
          ) : outreachError && !outreach ? (
            <div className="banner banner-error banner-tight">
              {outreachError}
            </div>
          ) : outreach ? (
            <>
              <div className="outreach-top">
                <span className="outreach-heading">Outreach</span>
                {outreach.cvVariant && (
                  <span className="pill">CV to send: {outreach.cvVariant}</span>
                )}
                <span className="grow" />
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => runOutreach(true)}
                  disabled={generating}
                  type="button"
                >
                  {generating ? 'Regenerating…' : 'Regenerate'}
                </button>
              </div>

              {outreachError && (
                <div className="banner banner-error banner-tight">
                  {outreachError}
                </div>
              )}

              <div className="outreach-field">
                <div className="outreach-field-head">
                  <span className="outreach-label">Referral message</span>
                  <CopyButton text={referral} />
                </div>
                <textarea
                  className="textarea outreach-textarea"
                  value={referral}
                  onChange={(e) => setReferral(e.target.value)}
                  rows={5}
                />
              </div>

              <div className="outreach-field">
                <div className="outreach-field-head">
                  <span className="outreach-label">Application note</span>
                  <CopyButton text={note} />
                </div>
                <textarea
                  className="textarea outreach-textarea"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={5}
                />
              </div>

              {outreach.targets.length > 0 && (
                <div className="outreach-field">
                  <span className="outreach-label">Who to contact</span>
                  <ul className="outreach-targets">
                    {outreach.targets.map((t, i) => (
                      <li className="outreach-target" key={`${t.searchUrl}-${i}`}>
                        <span className="outreach-target-title">{t.title}</span>
                        <a
                          className="btn btn-ghost btn-sm"
                          href={t.searchUrl}
                          target="_blank"
                          rel="noopener noreferrer"
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
        </div>
      )}
    </article>
  )
}
