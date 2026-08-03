import { useCallback, useEffect, useState } from 'react'
import type { Health, User } from './api'
import { getHealth, getMe, logout } from './api'
import ProfileView from './components/ProfileView'
import Dashboard from './components/Dashboard'
import SignIn from './components/SignIn'

type Tab = 'dashboard' | 'profile'

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

  if (!authChecked) {
    return (
      <div className="app">
        <main className="content">
          <p className="muted">Loading…</p>
        </main>
      </div>
    )
  }

  if (!user) {
    return <SignIn authEnabled={health?.auth !== false && !healthError} notice={notice} />
  }

  return (
    <div className="app">
      <header className="topnav">
        <div className="brand">
          <span className="brand-mark">◆</span>
          <span className="brand-name">Job Copilot</span>
        </div>

        <nav className="tabs">
          <button
            className={`tab${tab === 'dashboard' ? ' tab-active' : ''}`}
            onClick={() => setTab('dashboard')}
          >
            Dashboard
          </button>
          <button
            className={`tab${tab === 'profile' ? ' tab-active' : ''}`}
            onClick={() => setTab('profile')}
          >
            Profile
          </button>
        </nav>

        <div className="health">
          {healthError ? (
            <span
              className="health-chip health-down"
              title="Could not reach backend at localhost:4500"
            >
              backend offline
            </span>
          ) : health ? (
            <>
              <span
                className={`health-chip ${health.llm !== 'heuristic' ? 'health-llm' : 'health-heuristic'}`}
                title={
                  health.llm !== 'heuristic'
                    ? `Scoring with ${health.llm} (LLM)`
                    : 'Scoring heuristically — add a Gemini, Groq or Anthropic key for LLM scoring'
                }
              >
                {health.llm !== 'heuristic' ? `LLM scoring (${health.llm})` : 'heuristic scoring'}
              </span>
              <span
                className={`health-chip ${health.adzuna ? 'health-on' : 'health-off'}`}
                title={health.adzuna ? 'Adzuna source connected' : 'Adzuna not configured'}
              >
                adzuna {health.adzuna ? 'on' : 'off'}
              </span>
            </>
          ) : (
            <span className="health-chip health-muted">checking…</span>
          )}

          <span className="health-chip health-user" title={user.email}>
            {user.name || user.email}
          </span>
          <button className="tab signout-btn" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </header>

      <main className="content">
        {tab === 'dashboard' ? (
          <Dashboard onUnauthorized={onUnauthorized} />
        ) : (
          <ProfileView onUnauthorized={onUnauthorized} onAccountDeleted={onSignOut} />
        )}
      </main>
    </div>
  )
}
