import { useCallback, useEffect, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import type { Health, User } from './api'
import { API, getHealth, getJobs, getMe, logout, setStoredToken } from './api'
import ProfileView from './components/ProfileView'
import Dashboard from './components/Dashboard'
import SignIn from './components/SignIn'
import BrandMark from './components/BrandMark'
import Onboarding from './components/Onboarding'
import './styles/shell.css'

// Three destinations, not two-plus-a-filter. Career-page jobs and aggregator
// jobs are different kinds of supply — you work them differently — so they get
// their own place in the nav rather than hiding behind a dropdown.
type Tab = 'career-pages' | 'job-boards' | 'profile'

const TABS: { id: Tab; label: string; short: string }[] = [
  { id: 'career-pages', label: 'Career pages', short: 'Career' },
  { id: 'job-boards', label: 'API sources', short: 'API' },
  { id: 'profile', label: 'Profile', short: 'Profile' },
]

// Messages the OAuth callback can hand back via ?auth=…
const AUTH_NOTICES: Record<string, string> = {
  error: 'Sign-in failed. Please try again.',
  state_mismatch: 'Sign-in expired or was tampered with. Please try again.',
}

const LLM_LABELS: Record<Health['llm'], string> = {
  gemini: 'Gemini',
  groq: 'Groq',
  anthropic: 'Claude',
  heuristic: 'Keyword scoring',
}

// Whether the setup checklist has been dismissed. A convenience flag only — if
// storage is unavailable the checklist simply keeps showing.
const SETUP_HIDDEN_KEY = 'jc.setup.hidden'

function readSetupHidden(): boolean {
  try {
    return window.localStorage.getItem(SETUP_HIDDEN_KEY) === '1'
  } catch {
    return false
  }
}

function writeSetupHidden(hidden: boolean): void {
  try {
    if (hidden) window.localStorage.setItem(SETUP_HIDDEN_KEY, '1')
    else window.localStorage.removeItem(SETUP_HIDDEN_KEY)
  } catch {
    /* ignore: private-mode storage failures must not break the app */
  }
}

// Status is deliberately understated. A working backend is the normal case and
// should not shout; only an unreachable one gets colour and a border. The short
// form is what survives when the bar runs out of room.
function readStatus(
  health: Health | null,
  failed: boolean,
): { tone: 'ok' | 'warn' | 'idle' | 'down'; text: string; short: string; title: string } {
  if (failed) {
    return {
      tone: 'down',
      text: 'Backend offline',
      short: 'Offline',
      title: `Could not reach the API at ${API}. Nothing will load until it is back.`,
    }
  }
  if (!health) {
    return {
      tone: 'idle',
      text: 'Checking…',
      short: 'Checking',
      title: 'Checking the backend.',
    }
  }
  const boards = health.adzuna
    ? 'Adzuna job board connected.'
    : 'Adzuna job board not configured — career pages still work.'
  if (health.llm === 'heuristic') {
    return {
      tone: 'warn',
      text: 'Keyword scoring',
      short: 'Keyword',
      title: `No scoring key in use, so roles are ranked by keyword overlap alone. Add a key on the Profile tab to get scores with reasons. ${boards}`,
    }
  }
  // Says what you get, not which vendor supplies it. Whose model is doing the
  // work is a settings detail, not something for the header to announce on
  // every screen — and it changes on its own when the chain fails over.
  return {
    tone: 'ok',
    text: 'Scoring with reasons',
    short: 'Scoring',
    title: `Each posting is read in full and scored with a reason. Running on ${LLM_LABELS[health.llm]}. ${boards}`,
  }
}

export default function App() {
  const [tab, setTab] = useState<Tab>('career-pages')
  const [health, setHealth] = useState<Health | null>(null)
  const [healthError, setHealthError] = useState(false)
  const [user, setUser] = useState<User | null>(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [notice, setNotice] = useState<string | undefined>()
  const [setupHidden, setSetupHidden] = useState(readSetupHidden)
  // null until the checklist has worked out where the account stands.
  const [setupDone, setSetupDone] = useState<boolean | null>(null)

  const still = useReducedMotion()

  // Read (and then clear) the ?auth= flag and ?token= the backend redirect adds, so a failed
  // sign-in explains itself and the token is safely stashed in storage without lingering in the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const token = params.get('token')
    if (token) {
      setStoredToken(token)
    }
    const flag = params.get('auth')
    if (flag) {
      if (AUTH_NOTICES[flag]) setNotice(AUTH_NOTICES[flag])
    }
    if (flag || token) {
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [])

  useEffect(() => {
    let active = true
    getHealth()
      .then((h) => active && setHealth(h))
      .catch(() => active && setHealthError(true))
    getMe()
      .then((u) => active && setUser(u))
      .catch(() => active && setUser(null))
      .finally(() => active && setAuthChecked(true))
    return () => {
      active = false
    }
  }, [])

  // Land on the tab that has something worth reading.
  //
  // Career pages leads by design — those roles are the differentiated ones —
  // but design intent is not what the user should be shown on arrival. This
  // first checked only whether career pages was EMPTY, which was too weak: 19
  // career-page roles all scoring 5 is not empty, so it opened on a dashboard
  // reading "Nothing scores 50 or higher" while 1,700 board jobs with real
  // matches sat one tab away. Compare what actually clears the score floor.
  useEffect(() => {
    if (!user) return
    let active = true
    Promise.all([getJobs(50, 'scraped'), getJobs(50)])
      .then(([career, all]) => {
        if (!active) return
        const boards = all.jobs.filter((j) => j.source !== 'scraped').length
        if (career.jobs.length === 0 && boards > 0) setTab('job-boards')
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [user])

  const onSignOut = useCallback(async () => {
    await logout().catch(() => undefined)
    setUser(null)
    setTab('career-pages')
  }, [])

  // Any request can 401 if the session expires mid-session; drop back to sign-in.
  const onUnauthorized = useCallback(() => {
    setStoredToken(null)
    setUser(null)
    setNotice('Your session expired. Please sign in again.')
  }, [])

  // Deep link out of the checklist: land on the right destination and put focus
  // on its tab so keyboard and screen-reader users travel with the click.
  const goTo = useCallback((next: Tab) => {
    setTab(next)
    window.scrollTo({ top: 0, behavior: 'smooth' })
    requestAnimationFrame(() => document.getElementById(`shell-tab-${next}`)?.focus())
  }, [])

  const hideSetup = useCallback(() => {
    setSetupHidden(true)
    writeSetupHidden(true)
  }, [])

  const showSetup = useCallback(() => {
    setSetupHidden(false)
    writeSetupHidden(false)
  }, [])

  // Roving focus so the tablist behaves like one control, not three loose buttons.
  const onTabKeys = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      const i = TABS.findIndex((t) => t.id === tab)
      let target = -1
      if (e.key === 'ArrowRight') target = (i + 1) % TABS.length
      else if (e.key === 'ArrowLeft') target = (i - 1 + TABS.length) % TABS.length
      else if (e.key === 'Home') target = 0
      else if (e.key === 'End') target = TABS.length - 1
      else return
      e.preventDefault()
      const next = TABS[target]
      setTab(next.id)
      document.getElementById(`shell-tab-${next.id}`)?.focus()
    },
    [tab],
  )

  if (!authChecked) {
    return (
      <div className="app shell-app">
        <div className="shell-boot" role="status" aria-live="polite">
          <div className="shell-boot-inner">
            <span className="shell-mark shell-mark-lg" aria-hidden="true">
              <BrandMark size={14} />
            </span>
            <p className="shell-boot-text">Opening your workspace…</p>
            <span className="shell-boot-bar" aria-hidden="true">
              <i />
            </span>
          </div>
        </div>
      </div>
    )
  }

  if (!user) {
    return <SignIn authEnabled={health?.auth !== false && !healthError} notice={notice} />
  }

  const who = user.name || user.email
  const status = readStatus(health, healthError)

  return (
    <div className="app shell-app">
      <a className="shell-skip" href="#shell-panel">
        Skip to the job list
      </a>

      <header className="shell-bar">
        <div className="shell-bar-inner">
          <div className="shell-brand">
            <span className="shell-mark" aria-hidden="true">
              <BrandMark size={14} />
            </span>
            <span className="shell-wordmark">Shortlist</span>
          </div>

          {/* One indicator that slides between tabs, rather than three that
              fade in and out: the movement is what tells you where you came
              from. It is a layout animation, so it costs nothing while the tab
              is not changing, and it is switched off entirely for anyone who
              has asked for reduced motion. */}
          <nav className="shell-tabs" role="tablist" aria-label="Sections" onKeyDown={onTabKeys}>
            {TABS.map((t) => {
              const on = tab === t.id
              return (
                <button
                  key={t.id}
                  id={`shell-tab-${t.id}`}
                  className="shell-tab"
                  role="tab"
                  aria-selected={on}
                  aria-controls="shell-panel"
                  tabIndex={on ? 0 : -1}
                  onClick={() => setTab(t.id)}
                >
                  {on && (
                    <motion.span
                      className="shell-tab-ind"
                      aria-hidden="true"
                      layoutId={still ? undefined : 'shell-tab-ind'}
                      transition={{ type: 'spring', stiffness: 520, damping: 44, mass: 0.9 }}
                    />
                  )}
                  <span className="shell-tab-label">{t.label}</span>
                </button>
              )
            })}
          </nav>

          <div className="shell-right">
            {setupHidden && setupDone === false ? (
              <button className="shell-resume" onClick={showSetup}>
                Finish setup
              </button>
            ) : null}

            <span
              className="shell-status"
              data-tone={status.tone}
              title={status.title}
              role="status"
            >
              <i className="shell-status-dot" aria-hidden="true" />
              <span className="shell-status-text">{status.text}</span>
            </span>

            <span className="shell-user" title={user.email}>
              <span className="shell-avatar" aria-hidden="true">
                {who.slice(0, 1).toUpperCase()}
              </span>
              <span className="shell-user-name">{who}</span>
            </span>

            <button className="shell-signout" onClick={onSignOut}>
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="shell-main">
        <Onboarding
          hidden={setupHidden}
          refreshKey={tab}
          onHide={hideSetup}
          onGo={goTo}
          onStatus={setSetupDone}
          onUnauthorized={onUnauthorized}
        />

        <div
          className="shell-panel"
          id="shell-panel"
          role="tabpanel"
          aria-labelledby={`shell-tab-${tab}`}
          tabIndex={-1}
        >
          {tab === 'profile' ? (
            <ProfileView onUnauthorized={onUnauthorized} onAccountDeleted={onSignOut} />
          ) : (
            <Dashboard
              key={tab}
              view={tab}
              onUnauthorized={onUnauthorized}
              onSwitchView={goTo}
            />
          )}
        </div>
      </main>
    </div>
  )
}

// A navigator's arrow: the product points you at the next thing worth doing.
