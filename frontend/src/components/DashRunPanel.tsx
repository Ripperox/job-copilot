import { useEffect, useState } from 'react'

// The run controls, and the minute they cost you.
//
// A fetch reads every job source and then scores each new posting;
// 60–90 seconds is normal. The API answers exactly once, at the end, so there is
// no honest way to show a percentage — inventing one would be a lie that gets
// caught every time it stalls at 80%. What we can be truthful about is: how long
// this usually takes (said BEFORE you commit to it), how long it has actually
// been running, which two things the server is doing, and that the silence is
// expected. That is enough to stop it reading as frozen.
//
// The seconds tick inside this component on purpose: the parent never re-renders
// on the timer, so the job list stays interactive while a run is in flight.

export type RunPhase = 'idle' | 'fetching' | 'rescoring'

export function formatElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

const STEPS: Record<'fetching' | 'rescoring', string[]> = {
  fetching: [
    'Reading every job source for new postings',
    'Scoring each new posting against your profile',
  ],
  rescoring: ['Re-scoring every job in the pool against your current profile'],
}

// Said out loud so a long wait never looks like a hang. Thresholds describe our
// own request — never a guess at which stage the server is on.
function reassurance(phase: 'fetching' | 'rescoring', secs: number): string {
  if (secs > 180) {
    return 'This is unusually slow, but the request is still open. Leave the tab in the background — it will either land or tell you it failed.'
  }
  if (secs > 90) {
    return 'Taking longer than usual. Still connected and still running; a big batch of new postings can take a few minutes to score.'
  }
  return phase === 'fetching'
    ? 'The server answers once, at the end, so nothing will move until it lands. Usually about a minute.'
    : 'How long this takes depends on the size of your pool. Usually under a minute.'
}

export default function DashRunPanel({
  phase,
  layout,
  canRescore,
  onFetch,
  onRescore,
}: {
  phase: RunPhase
  /** 'rail' — boxed, stacked, for the career-pages sidebar. 'bar' — inline, for the job-boards console. */
  layout: 'rail' | 'bar'
  canRescore: boolean
  onFetch: () => void
  onRescore: () => void
}) {
  const [secs, setSecs] = useState(0)

  useEffect(() => {
    if (phase === 'idle') {
      setSecs(0)
      return
    }
    const startedAt = Date.now()
    setSecs(0)
    const id = window.setInterval(() => {
      setSecs(Math.round((Date.now() - startedAt) / 1000))
    }, 1000)
    return () => window.clearInterval(id)
  }, [phase])

  const running = phase !== 'idle'

  return (
    <section
      className={`dsh-run is-${layout}${running ? ' is-running' : ''}`}
      aria-label="Fetch and score"
    >
      <div className="dsh-run-acts">
        <button
          type="button"
          className="dsh-cta"
          onClick={onFetch}
          disabled={running}
        >
          {phase === 'fetching' ? 'Fetching…' : 'Fetch & score jobs'}
        </button>
        <button
          type="button"
          className="dsh-btn"
          onClick={onRescore}
          disabled={running || !canRescore}
          title="Score every job you already have against your current profile — worth doing after editing your profile or adding an API key"
        >
          {phase === 'rescoring' ? 'Re-scoring…' : 'Re-score'}
        </button>
      </div>

      {!running && (
        <p className="dsh-run-note">
          Reads every source, then scores what’s new.{' '}
          <strong>About a minute</strong> — you can keep working while it runs.
        </p>
      )}

      {running && (
        <div className="dsh-prog">
          <div className="dsh-prog-head">
            <span className="live-dot" aria-hidden="true" />
            <span className="dsh-prog-t">
              {phase === 'fetching' ? 'Fetching and scoring' : 'Re-scoring your pool'}
            </span>
            <span className="dsh-prog-time" aria-hidden="true">
              {formatElapsed(secs)} elapsed
            </span>
          </div>

          <div
            className="dsh-bar"
            role="progressbar"
            aria-label={
              phase === 'fetching'
                ? 'Fetching and scoring jobs'
                : 'Re-scoring jobs'
            }
          >
            <i aria-hidden="true" />
          </div>

          <ol className="dsh-steps">
            {STEPS[phase].map((step, i) => (
              <li className="dsh-step" key={step}>
                <span className="dsh-step-i" aria-hidden="true">
                  {i + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>

          <p className="dsh-prog-say" role="status">
            {reassurance(phase, secs)}
          </p>
        </div>
      )}
    </section>
  )
}
