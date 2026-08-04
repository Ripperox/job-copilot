import { useCallback, useEffect, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { Health, User } from './api'
import { getHealth, getMe, logout } from './api'
import ProfileView from './components/ProfileView'
import Dashboard from './components/Dashboard'
import SignIn from './components/SignIn'
import './styles/shell.css'

type Tab = 'dashboard' | 'profile'

const TABS: { id: Tab; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'profile', label: 'Profile' },
]

// Messages the OAuth callback can hand back via ?auth=…
const AUTH_NOTICES: Record<string, string> = {
  error: 'Sign-in failed. Please try again.',
  state_mismatch: 'Sign-in expired or was tampered with. Please try again.',
}

export default function App() {
  const [tab, setTab] = useState<Tab>('dashboard')
  const [health, setHealth] = useState<Health | null>(null)
  const [healthError, setHealthError] = useState(false)
  const [user, setUser] = useState<User | null>(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [notice, setNotice] = useState<string | undefined>()

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

  const onSignOut = useCallback(async () => {
    await logout().catch(() => undefined)
    setUser(null)
    setTab('dashboard')
  }, [])

  // Any request can 401 if the session expires mid-session; drop back to sign-in.
  const onUnauthorized = useCallback(() => {
    setUser(null)
    setNotice('Your session expired. Please sign in again.')
  }, [])

  // Roving focus so the tablist behaves like one, not like two loose buttons.
  const onTabKeys = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
      e.preventDefault()
      const i = TABS.findIndex((t) => t.id === tab)
      const step = e.key === 'ArrowRight' ? 1 : TABS.length - 1
      const next = TABS[(i + step) % TABS.length]
      setTab(next.id)
      document.getElementById(`shell-tab-${next.id}`)?.focus()
    },
    [tab],
  )

  if (!authChecked) {
    return (
      <div className="app shell-app">
        <div className="shell-boot">
          <div className="shell-boot-inner">
            <p className="shell-boot-cmd">
              <span className="si-prompt">$</span> job-copilot --boot
            </p>
            <p className="shell-boot-line">
              Loading… <span className="shell-caret" aria-hidden="true" />
            </p>
          </div>
        </div>
      </div>
    )
  }

  if (!user) {
    return <SignIn authEnabled={health?.auth !== false && !healthError} notice={notice} />
  }

  const who = user.name || user.email

  return (
    <div className="app shell-app">
      <header className="shell-bar">
        <div className="shell-bar-inner">
          <div className="shell-brand">
            <span className="shell-mark" aria-hidden="true">
              ◆
            </span>
            <span className="shell-brand-text">
              <span className="shell-wordmark">Job Copilot</span>
              <span className="shell-brand-sub">job pipeline</span>
            </span>
          </div>

          <nav
            className="shell-tabs"
            role="tablist"
            aria-label="Sections"
            onKeyDown={onTabKeys}
          >
            {TABS.map((t, i) => (
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
                <span className="shell-tab-i" aria-hidden="true">
                  {String(i + 1).padStart(2, '0')}
                </span>
                {t.label}
              </button>
            ))}
          </nav>

          <div className="shell-telemetry">
            {healthError ? (
              <span
                className="shell-chip is-down"
                title="Could not reach backend at localhost:4500"
              >
                <i className="shell-led" aria-hidden="true" />
                <span className="shell-key">backend</span>
                <span className="shell-val">offline</span>
              </span>
            ) : health ? (
              <>
                <span
                  className={`shell-chip ${health.llm !== 'heuristic' ? 'is-on' : 'is-warn'}`}
                  title={
                    health.llm !== 'heuristic'
                      ? `Scoring with ${health.llm} (LLM)`
                      : 'Scoring heuristically — add a Gemini, Groq or Anthropic key for LLM scoring'
                  }
                >
                  <i className="shell-led" aria-hidden="true" />
                  <span className="shell-key">llm</span>
                  <span className="shell-val">
                    {health.llm !== 'heuristic' ? health.llm : 'heuristic'}
                  </span>
                </span>
                <span
                  className={`shell-chip ${health.adzuna ? 'is-on' : 'is-idle'}`}
                  title={health.adzuna ? 'Adzuna source connected' : 'Adzuna not configured'}
                >
                  <i className="shell-led" aria-hidden="true" />
                  <span className="shell-key">adzuna</span>
                  <span className="shell-val">{health.adzuna ? 'on' : 'off'}</span>
                </span>
              </>
            ) : (
              <span className="shell-chip is-idle">
                <i className="shell-led" aria-hidden="true" />
                <span className="shell-key">health</span>
                <span className="shell-val">checking…</span>
              </span>
            )}
          </div>

          <div className="shell-account">
            <span className="shell-user" title={user.email}>
              <span className="shell-user-avatar" aria-hidden="true">
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

      <main
        className="content"
        id="shell-panel"
        role="tabpanel"
        aria-labelledby={`shell-tab-${tab}`}
      >
        {tab === 'dashboard' ? (
          <Dashboard onUnauthorized={onUnauthorized} />
        ) : (
          <ProfileView onUnauthorized={onUnauthorized} onAccountDeleted={onSignOut} />
        )}
      </main>
    </div>
  )
}
