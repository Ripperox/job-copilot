import { useEffect, useState } from 'react'
import type { Health } from './api'
import { getHealth } from './api'
import ProfileView from './components/ProfileView'
import Dashboard from './components/Dashboard'

type Tab = 'dashboard' | 'profile'

export default function App() {
  const [tab, setTab] = useState<Tab>('dashboard')
  const [health, setHealth] = useState<Health | null>(null)
  const [healthError, setHealthError] = useState(false)

  useEffect(() => {
    let active = true
    getHealth()
      .then((h) => {
        if (active) setHealth(h)
      })
      .catch(() => {
        if (active) setHealthError(true)
      })
    return () => {
      active = false
    }
  }, [])

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
                    : 'Scoring heuristically — add a Groq or Anthropic key for LLM scoring'
                }
              >
                {health.llm !== 'heuristic' ? `LLM scoring (${health.llm})` : 'heuristic scoring'}
              </span>
              <span
                className={`health-chip ${health.adzuna ? 'health-on' : 'health-off'}`}
                title={
                  health.adzuna ? 'Adzuna source connected' : 'Adzuna not configured'
                }
              >
                adzuna {health.adzuna ? 'on' : 'off'}
              </span>
            </>
          ) : (
            <span className="health-chip health-muted">checking…</span>
          )}
        </div>
      </header>

      <main className="content">
        {tab === 'dashboard' ? <Dashboard /> : <ProfileView />}
      </main>
    </div>
  )
}
