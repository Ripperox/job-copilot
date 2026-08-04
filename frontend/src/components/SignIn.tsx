import { useEffect, useState } from 'react'
import type { ScoredJob } from '../api'
import { getDemoJob, startGoogleLogin } from '../api'

// The five things the product does, in order. Restates the pitch below as a
// readout so the mechanism is visible before anyone signs up.
const PIPELINE: { k: string; v: string; manual?: boolean }[] = [
  { k: 'source', v: '5 feeds' },
  { k: 'score', v: 'résumé' },
  { k: 'draft', v: 'outreach' },
  { k: 'send', v: 'you', manual: true },
  { k: 'track', v: 'pipeline' },
]

// Shown whenever there is no session. The button is a full-page redirect because
// Google's consent screen cannot be loaded via fetch().
export default function SignIn({ authEnabled, notice }: { authEnabled: boolean; notice?: string }) {
  // One real, pre-scored job so a visitor can see the output before signing up.
  const [demo, setDemo] = useState<ScoredJob | null>(null)

  useEffect(() => {
    let active = true
    getDemoJob()
      .then((j) => active && setDemo(j))
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  const high = demo?.score != null && demo.score >= 70

  return (
    <div className="si">
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

          <div className="shell-telemetry">
            <span className="shell-chip is-idle" title="No active session">
              <i className="shell-led" aria-hidden="true" />
              <span className="shell-key">session</span>
              <span className="shell-val">signed out</span>
            </span>
            <span
              className={`shell-chip ${authEnabled ? 'is-on' : 'is-warn'}`}
              title={
                authEnabled
                  ? 'Google sign-in is configured on this server'
                  : 'Google sign-in is not configured on this server'
              }
            >
              <i className="shell-led" aria-hidden="true" />
              <span className="shell-key">auth</span>
              <span className="shell-val">{authEnabled ? 'ready' : 'unconfigured'}</span>
            </span>
          </div>
        </div>
      </header>

      <main className="si-main">
        <section className="si-pitch">
          <div className="sec">
            <span className="sec-index">00</span>
            <span className="sec-rule" />
            <span className="sec-cmd">$ job-copilot --start</span>
          </div>

          <h1 className="si-title">
            Your job search,
            <span className="si-title-accent">scored and tracked.</span>
          </h1>

          <p className="si-sub">
            <span className="si-sub-lede">
              Pulls roles from five sources, scores every one against your résumé,
            </span>{' '}
            drafts the outreach, and tracks each application through the pipeline.
          </p>

          <ol className="si-pipe">
            {PIPELINE.map((s, i) => (
              <li key={s.k} className={`si-pipe-step${s.manual ? ' is-manual' : ''}`}>
                <span className="si-pipe-i" aria-hidden="true">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span className="si-pipe-k">{s.k}</span>
                <span className="si-pipe-v">{s.v}</span>
              </li>
            ))}
          </ol>

          <p className="si-pipe-note">You stay the send button.</p>

          {notice && <p className="si-notice">{notice}</p>}

          {authEnabled ? (
            <>
              <button className="si-cta" onClick={startGoogleLogin}>
                Continue with Google
                <span className="si-cta-arrow" aria-hidden="true">
                  →
                </span>
              </button>
              <p className="si-cta-note">google oauth · full-page redirect</p>
            </>
          ) : (
            <p className="si-notice">
              Google sign-in is not configured on this server. Set GOOGLE_CLIENT_ID,
              GOOGLE_CLIENT_SECRET and SESSION_SECRET in the backend .env.
            </p>
          )}

          <p className="si-fine">
            We store your résumé text and job pipeline so the app can score roles for you.
            You can delete your account and all of its data at any time from the Profile tab.
          </p>
        </section>

        {demo && (
          <aside className="si-demo corner-frame" aria-label="Live example — one real scored job">
            <div className="si-demo-bar">
              <span className="live-dot" aria-hidden="true" />
              <span className="si-demo-path">demo · one real scored job</span>
              {demo.source && <span className="si-demo-src">src {demo.source}</span>}
            </div>

            <div className="si-demo-body">
              <p className="si-line si-line-cmd">
                <span className="si-prompt">$</span> jc score --demo
              </p>
              <p className="si-line si-line-sys">↳ 1 result · pre-scored · read-only</p>

              <div className="si-job">
                <div className={`si-score-wrap${high ? ' is-high' : ''}`}>
                  <span className="si-score">{demo.score ?? '—'}</span>
                  <span className="si-score-cap">score</span>
                  {demo.score != null && (
                    <span className="si-meter" aria-hidden="true">
                      <i style={{ width: `${Math.max(0, Math.min(100, demo.score))}%` }} />
                    </span>
                  )}
                </div>
                <div className="si-job-id">
                  <h2 className="si-job-title">{demo.title}</h2>
                  <div className="si-job-meta">
                    <span className="si-job-co">{demo.company}</span> · {demo.location}
                  </div>
                </div>
              </div>

              {demo.reason && <p className="si-reason">{demo.reason}</p>}
            </div>

            <p className="si-demo-foot">
              Sign in and add your résumé to score the whole pool against your own background.
            </p>
          </aside>
        )}
      </main>
    </div>
  )
}
