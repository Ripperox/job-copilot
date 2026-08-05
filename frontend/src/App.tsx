import { useCallback, useEffect, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { Health, User } from './api'
import { API, getHealth, getMe, getSources, logout } from './api'
import ProfileView from './components/ProfileView'
import Dashboard from './components/Dashboard'
import SignIn from './components/SignIn'
import Onboarding from './components/Onboarding'
import './styles/shell.css'

// Three destinations, not two-plus-a-filter. Career-page jobs and aggregator
// jobs are different kinds of supply — you work them differently — so they get
// their own place in the nav rather than hiding behind a dropdown.
type Tab = 'career-pages' | 'job-boards' | 'profile'

const TABS: { id: Tab; label: string }[] = [
  { id: 'career-pages', label: 'Career pages' },
  { id: 'job-boards', label: 'Job boards' },
  { id: 'profile', label: 'Profile' },
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
// should not shout; only an unreachable one gets colour and a border.
function readStatus(
  health: Health | null,
  failed: boolean,
): { tone: 'ok' | 'warn' | 'idle' | 'down'; text: string; title: string } {
  if (failed) {
    return {
      tone: 'down',
      text: 'Backend offline',
      title: `Could not reach the API at ${API}. Nothing will load until it is back.`,
    }
  }
  if (!health) {
    return { tone: 'idle', text: 'Checking…', title: 'Checking the backend.' }
  }
  const boards = health.adzuna
    ? 'Adzuna job board connected.'
    : 'Adzuna job board not configured — career pages still work.'
  if (health.llm === 'heuristic') {
    return {
      tone: 'warn',
      text: 'Keyword scoring',
      title: `No model key in use, so jobs are scored by keyword overlap. Add a key on the Profile tab for scores with reasons. ${boards}`,
    }
  }
  return {
    tone: 'ok',
    text: `Scoring with ${LLM_LABELS[health.llm]}`,
    title: `${LLM_LABELS[health.llm]} is reading each posting and explaining its score. ${boards}`,
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

  // Read (and then clear) the ?auth= flag the backend redirect adds, so a failed
  // sign-in explains itself and the query string does not linger in the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const flag = params.get('auth')
    if (flag) {
      if (AUTH_NOTICES[flag]) setNotice(AUTH_NOTICES[flag])
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

  // Career pages leads by design — those roles are the differentiated ones. But
  // landing on an empty dashboard is the worst possible first screen, and that
  // tab stays empty until the server has career-page URLs configured. So: check
  // once, and fall back to job boards when there is genuinely nothing to show.
  useEffect(() => {
    if (!user) return
    let active = true
    getSources()
      .then((s) => {
        if (!active) return
        const career = s.sources.find((x) => x.name === 'scraped')?.count ?? 0
        const boards = s.sources.reduce(
          (n, x) => n + (x.name === 'scraped' ? 0 : x.count),
          0,
        )
        if (career === 0 && boards > 0) setTab('job-boards')
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
              <BrandGlyph />
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
      <header className="shell-bar">
        <div className="shell-bar-inner">
          <div className="shell-brand">
            <span className="shell-mark" aria-hidden="true">
              <BrandGlyph />
            </span>
            <span className="shell-wordmark">Job Copilot</span>
          </div>

          <nav className="shell-tabs" role="tablist" aria-label="Sections" onKeyDown={onTabKeys}>
            {TABS.map((t) => (
              <button
                key={t.id}
                id={`shell-tab-${t.id}`}
                className="shell-tab"
                role="tab"
                aria-selected={tab === t.id}
                aria-controls="shell-panel"
                tabIndex={tab === t.id ? 0 : -1}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
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
        >
          {tab === 'profile' ? (
            <ProfileView onUnauthorized={onUnauthorized} onAccountDeleted={onSignOut} />
          ) : (
            <Dashboard key={tab} view={tab} onUnauthorized={onUnauthorized} />
          )}
        </div>
      </main>
    </div>
  )
}

// A navigator's arrow: the product points you at the next thing worth doing.
function BrandGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="M12 3.5 19 20.5 12 16.6 5 20.5z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  )
}
