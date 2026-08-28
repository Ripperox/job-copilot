import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { UnauthorizedError, getKeyStatus, getProfile, getSources } from '../api'
import '../styles/onboarding.css'

type Destination = 'career-pages' | 'profile' | 'job-boards'

const KEY_SKIPPED = 'jc.setup.key-skipped'
const ONBOARDING_DISMISSED = 'jc.onboarding.dismissed'

interface SetupState {
  resumeChars: number
  hasKey: boolean
  keyMask: string | null
  provider: string | null
  jobCount: number
}

interface Step {
  id: string
  title: string
  description: string
  icon: ReactNode
  check: (state: SetupState) => boolean
  action: { label: string; destination: Destination }
  optional?: boolean
  skipped?: boolean
}

function readSkipped(): boolean {
  try {
    return window.localStorage.getItem(KEY_SKIPPED) === '1'
  } catch {
    return false
  }
}

function writeSkipped(): void {
  try {
    window.localStorage.setItem(KEY_SKIPPED, '1')
  } catch {
    /* ignore */
  }
}

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(ONBOARDING_DISMISSED) === '1'
  } catch {
    return false
  }
}

function writeDismissed(): void {
  try {
    window.localStorage.setItem(ONBOARDING_DISMISSED, '1')
  } catch {
    /* ignore */
  }
}

export default function Onboarding({
  hidden,
  refreshKey,
  onHide,
  onGo,
  onStatus,
  onUnauthorized,
}: {
  hidden: boolean
  refreshKey?: string | number
  onHide: () => void
  onGo: (destination: Destination) => void
  onStatus?: (complete: boolean) => void
  onUnauthorized?: () => void
}) {
  const [setup, setSetup] = useState<SetupState | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [keySkipped, setKeySkipped] = useState(readSkipped)
  const [dismissed, setDismissed] = useState(readDismissed)

  const load = useCallback(async () => {
    setFailed(false)
    try {
      const [profile, key, sources] = await Promise.all([
        getProfile(),
        getKeyStatus(),
        getSources().catch(() => null),
      ])
      setSetup({
        resumeChars: profile?.resumeText.trim().length ?? 0,
        hasKey: key.hasKey,
        keyMask: key.mask,
        provider: key.provider,
        jobCount: sources ? sources.sources.reduce((n, s) => n + s.count, 0) : 0,
      })
    } catch (err: unknown) {
      if (err instanceof UnauthorizedError) return onUnauthorized?.()
      setFailed(true)
    } finally {
      setLoaded(true)
    }
  }, [onUnauthorized])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const steps: Step[] = [
    {
      id: 'resume',
      title: 'Add your résumé',
      description: 'Every score compares a job against this text. Upload a PDF or paste it in.',
      icon: (
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
      ),
      check: (s) => s.resumeChars > 0,
      action: { label: 'Add résumé', destination: 'profile' },
    },
    {
      id: 'key',
      title: 'Add a scoring key',
      description: 'A Groq, Gemini or Anthropic key lets the model read each posting and explain its score.',
      icon: (
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="2" y="4" width="20" height="16" rx="2" />
          <path d="M6 8h12M6 12h10M6 16h8" />
        </svg>
      ),
      check: (s) => s.hasKey,
      action: { label: 'Add key', destination: 'profile' },
      optional: true,
    },
    {
      id: 'matches',
      title: 'See your matches',
      description: 'Jobs are already collected. Save your résumé and they get scored automatically.',
      icon: (
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
      ),
      check: (s) => s.resumeChars > 0 && s.jobCount > 0,
      action: { label: 'View matches', destination: 'career-pages' },
    },
  ]

  const defaultState: SetupState = { resumeChars: 0, hasKey: false, keyMask: null, provider: null, jobCount: 0 }
  const resumeDone = steps[0].check(setup ?? defaultState)
  const keyDone = steps[1].check(setup ?? defaultState)
  const matchesDone = steps[2].check(setup ?? defaultState)
  const doneCount = [resumeDone, keyDone, matchesDone].filter(Boolean).length
  const complete = Boolean(setup) && resumeDone && matchesDone

  useEffect(() => {
    if (loaded && setup) onStatus?.(complete)
  }, [complete, loaded, setup, onStatus])

  const skipKey = useCallback(() => {
    writeSkipped()
    setKeySkipped(true)
  }, [])

  const handleDismiss = useCallback(() => {
    writeDismissed()
    setDismissed(true)
    onHide()
  }, [onHide])

  if (hidden || dismissed || (loaded && complete)) return null

  if (!loaded) {
    return (
      <section className="ob ob-loading" aria-hidden="true">
        <span className="u-skeleton ob-skel ob-skel-title" />
        <span className="u-skeleton ob-skel ob-skel-row" />
        <span className="u-skeleton ob-skel ob-skel-row" />
        <span className="u-skeleton ob-skel ob-skel-row" />
      </section>
    )
  }

  if (failed || !setup) {
    return (
      <section className="ob ob-quiet">
        <p className="ob-why">Could not check setup progress. The backend may be down.</p>
        <button className="ob-go is-quiet" onClick={() => void load()}>Try again</button>
      </section>
    )
  }

  return (
    <section className="ob" aria-labelledby="ob-title">
      <header className="ob-head">
        <div className="ob-head-text">
          <h2 className="ob-title" id="ob-title">Welcome to Shortlist</h2>
          <p className="ob-sub">Three quick steps and you'll have scored job matches.</p>
        </div>
        <div className="ob-meta">
          <span className="ob-count"><span className="u-num">{doneCount}</span> of <span className="u-num">3</span> done</span>
          <button className="ob-hide" onClick={handleDismiss} title="You can bring this back from the top bar">Hide</button>
        </div>
      </header>

      <ol className="ob-steps">
        {steps.map((step, index) => {
          const isDone = step.check(setup)
          const isSkipped = step.optional && keySkipped
          const state = isDone ? 'done' : isSkipped ? 'skipped' : 'todo'
          const isNext = !isDone && !isSkipped && steps.slice(0, index).every(s => s.check(setup))

          return (
            <li key={step.id} className={`ob-step is-${state}${isNext ? ' is-next' : ''}`} style={{ animationDelay: `${index * 60}ms` }}>
              <span className="ob-mark" aria-hidden="true">
                {state === 'done' ? (
                  <svg viewBox="0 0 16 16" width="14" height="14" focusable="false"><path d="M3 8.4 6.3 11.7 13 5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                ) : state === 'skipped' ? (
                  <svg viewBox="0 0 16 16" width="14" height="14" focusable="false"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
                ) : (
                  <span className="u-num">{index + 1}</span>
                )}
              </span>

              <div className="ob-body">
                <h3 className="ob-h">
                  {step.title}
                  {step.optional && <span className="ob-opt">Optional</span>}
                  <span className="ob-sr">{state === 'done' ? ' — done' : state === 'skipped' ? ' — skipped' : ' — not done'}</span>
                </h3>
                <p className="ob-why">{step.description}</p>
                {step.optional && !isDone && !isSkipped && (
                  <p className="ob-honest">Skip → keyword matching only (no written reasons).</p>
                )}
                {isDone && (
                  <p className="ob-state">
                    {step.id === 'resume' && `Saved · <span className="u-num">${setup.resumeChars.toLocaleString()}</span> chars`}
                    {step.id === 'key' && setup.provider && `${setup.provider} key saved · <span className="u-mono">${setup.keyMask ?? 'stored'}</span>`}
                    {step.id === 'matches' && `<span className="u-num">${setup.jobCount.toLocaleString()}</span> postings in your pipeline`}
                  </p>
                )}
              </div>

              <div className="ob-actions">
                {step.optional && !isDone && !isSkipped && (
                  <button className="ob-skip" onClick={skipKey}>Skip for now</button>
                )}
                <button
                  className={`ob-go${isNext && state !== 'done' ? '' : ' is-quiet'}`}
                  onClick={() => onGo(step.action.destination)}
                >
                  {isDone ? (step.id === 'matches' ? 'Go to matches' : 'Edit') : step.action.label}
                </button>
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}