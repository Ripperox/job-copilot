import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { UnauthorizedError, getKeyStatus, getProfile, getSources } from '../api'
import '../styles/onboarding.css'

// Where a step sends you. Mirrors the shell's tab ids.
type Destination = 'career-pages' | 'profile'

// The key step is optional, so "skip" is a real, remembered answer rather than
// a step you leave hanging forever.
const KEY_SKIPPED = 'jc.setup.key-skipped'

// The backend reports the provider in lowercase; prose is sentence case.
const PROVIDER_LABELS: Record<string, string> = {
  groq: 'Groq key',
  gemini: 'Gemini key',
  anthropic: 'Anthropic key',
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
    /* ignore: private-mode storage failures must not break the app */
  }
}

interface Setup {
  resumeChars: number
  hasKey: boolean
  keyMask: string | null
  provider: string | null
  jobCount: number
}

/**
 * The first-run checklist.
 *
 * A new account lands on an empty dashboard with three things standing between
 * it and a scored job — résumé, scoring key, first fetch — and until now the
 * app never said so. This is that sequence, stated once, in order, with the
 * reason each step exists. It is a checklist and not a wizard on purpose:
 * nothing is blocked, nothing is modal, and you can leave at any point.
 */
export default function Onboarding({
  hidden,
  refreshKey,
  onHide,
  onGo,
  onStatus,
  onUnauthorized,
}: {
  hidden: boolean
  // Changing this re-checks the account — e.g. after a trip to the Profile tab.
  refreshKey?: string | number
  onHide: () => void
  onGo: (destination: Destination) => void
  onStatus?: (complete: boolean) => void
  onUnauthorized?: () => void
}) {
  const [setup, setSetup] = useState<Setup | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [keySkipped, setKeySkipped] = useState(readSkipped)

  const load = useCallback(async () => {
    setFailed(false)
    try {
      const [profile, key, sources] = await Promise.all([
        getProfile(),
        getKeyStatus(),
        // Job count is nice-to-have; a failure here should not blank the list.
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

  const resumeDone = (setup?.resumeChars ?? 0) > 0
  const keyDone = setup?.hasKey === true
  const jobsDone = (setup?.jobCount ?? 0) > 0
  // The key is genuinely optional, so it does not gate "set up".
  const complete = Boolean(setup) && resumeDone && jobsDone

  useEffect(() => {
    if (loaded && setup) onStatus?.(complete)
  }, [complete, loaded, setup, onStatus])

  const skipKey = useCallback(() => {
    writeSkipped()
    setKeySkipped(true)
  }, [])

  if (hidden || (loaded && complete)) return null

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
        <p className="ob-why">
          Could not check how far your setup has got. The backend may be down.
        </p>
        <button className="ob-go is-quiet" onClick={() => void load()}>
          Try again
        </button>
      </section>
    )
  }

  const doneCount = [resumeDone, keyDone, jobsDone].filter(Boolean).length
  // The first unfinished step gets the emphasis; everything after it stays calm.
  const next: 1 | 2 | 3 = !resumeDone ? 1 : !keyDone && !keySkipped ? 2 : 3

  return (
    <section className="ob" aria-labelledby="ob-title">
      <header className="ob-head">
        <div className="ob-head-text">
          <h2 className="ob-title" id="ob-title">
            Three things and you are running
          </h2>
          <p className="ob-sub">
            Shortlist scores every posting it finds against your résumé and drafts the
            outreach for the ones worth your time. This is the setup that makes that work — any
            order, and you can come back later.
          </p>
        </div>
        <div className="ob-meta">
          <span className="ob-count">
            <span className="u-num">{doneCount}</span> of <span className="u-num">3</span> done
          </span>
          <button className="ob-hide" onClick={onHide} title="You can bring this back from the top bar">
            Hide
          </button>
        </div>
      </header>

      <ol className="ob-steps">
        <Step
          index={1}
          state={resumeDone ? 'done' : 'todo'}
          emphasis={next === 1}
          title="Add your résumé"
          why="Drop in the PDF you already have. Every score is a comparison against this text, so without it there is nothing to match a job to."
          done={
            resumeDone ? (
              <>
                Saved · <span className="u-num">{setup.resumeChars.toLocaleString()}</span>{' '}
                characters
              </>
            ) : null
          }
          action={{ label: resumeDone ? 'Edit résumé' : 'Add résumé', to: 'profile' }}
          onGo={onGo}
        />

        <Step
          index={2}
          state={keyDone ? 'done' : keySkipped ? 'skipped' : 'todo'}
          emphasis={next === 2}
          optional
          title="Add a scoring key"
          why="A Groq, Gemini or Anthropic key lets a model read each posting properly and say why it scored what it did."
          honest={
            keyDone
              ? null
              : 'Without a key nothing breaks: scoring falls back to keyword matching. It is blunter and it cannot explain itself, but it works.'
          }
          done={
            keyDone ? (
              <>
                {PROVIDER_LABELS[setup.provider ?? ''] ?? 'Key'} saved ·{' '}
                <span className="u-mono">{setup.keyMask ?? 'stored'}</span>
              </>
            ) : keySkipped ? (
              'Skipped — scoring by keyword match for now.'
            ) : null
          }
          action={{ label: keyDone ? 'Manage key' : 'Add a key', to: 'profile' }}
          onGo={onGo}
          onSkip={keyDone || keySkipped ? undefined : skipKey}
        />

        <Step
          index={3}
          state={jobsDone ? 'done' : 'todo'}
          emphasis={next === 3}
          title="See your matches"
          why="Postings are already collected from company career pages and the job boards. Saving your résumé starts scoring them against it."
          done={
            jobsDone ? (
              <>
                <span className="u-num">{setup.jobCount.toLocaleString()}</span> postings in your
                pipeline
              </>
            ) : resumeDone ? (
              // The seeding pass runs in the background on first profile save,
              // so this is a wait, not a chore. Say so rather than implying the
              // user has forgotten to press something.
              'Scoring your first batch now — this takes a minute or two. Refresh to check.'
            ) : (
              'Starts on its own once your résumé is saved.'
            )
          }
          action={{ label: 'Go to career pages', to: 'career-pages' }}
          onGo={onGo}
        />
      </ol>
    </section>
  )
}

function Step({
  index,
  state,
  emphasis,
  optional,
  title,
  why,
  honest,
  done,
  action,
  onGo,
  onSkip,
}: {
  index: number
  state: 'done' | 'todo' | 'skipped'
  emphasis: boolean
  optional?: boolean
  title: string
  why: string
  honest?: string | null
  done?: ReactNode
  action: { label: string; to: Destination }
  onGo: (destination: Destination) => void
  onSkip?: () => void
}) {
  const cls = `ob-step is-${state}${emphasis ? ' is-next' : ''}`
  return (
    <li className={cls} style={{ animationDelay: `${(index - 1) * 60}ms` }}>
      <span className="ob-mark" aria-hidden="true">
        {state === 'done' ? (
          <svg viewBox="0 0 16 16" width="11" height="11" focusable="false">
            <path
              d="M3 8.4 6.3 11.7 13 5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <span className="u-num">{index}</span>
        )}
      </span>

      <div className="ob-body">
        <h3 className="ob-h">
          {title}
          {optional ? <span className="ob-opt">Optional</span> : null}
          <span className="ob-sr">
            {state === 'done' ? ' — done' : state === 'skipped' ? ' — skipped' : ' — not done yet'}
          </span>
        </h3>
        <p className="ob-why">{why}</p>
        {honest ? <p className="ob-honest">{honest}</p> : null}
        {done ? <p className="ob-state">{done}</p> : null}
      </div>

      <div className="ob-actions">
        {onSkip ? (
          <button className="ob-skip" onClick={onSkip}>
            Skip for now
          </button>
        ) : null}
        <button
          className={`ob-go${emphasis && state !== 'done' ? '' : ' is-quiet'}`}
          onClick={() => onGo(action.to)}
        >
          {action.label}
        </button>
      </div>
    </li>
  )
}
