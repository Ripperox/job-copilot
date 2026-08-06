import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { ScoredJob } from '../api'
import { getDemoJob, startGoogleLogin } from '../api'
import { formatSalary } from '../lib/format'
import '../styles/signin.css'

// What actually happens once someone signs in. Kept to three steps, in the
// order they happen, because "what am I agreeing to" is the question a
// signed-out visitor is really asking.
const STEPS: { lead: string; rest: string }[] = [
  {
    lead: 'Paste your résumé',
    rest: 'plus the roles, locations and salary floor you are targeting.',
  },
  {
    lead: 'Shortlist fetches new openings',
    rest: 'and scores each one from 0 to 100, with a line explaining why.',
  },
  {
    lead: 'Draft the outreach, send it yourself',
    rest: 'then track each role from new through applied to interview.',
  },
]

// "3 Jun" — the posted date is data, so it is rendered in mono alongside the
// other facts. Undated or unparseable postings simply drop the cell.
function shortDate(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}

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
  const posted = demo ? shortDate(demo.postedAt) : null

  return (
    <div className="lp">
      <header className="lp-top">
        <div className="lp-top-inner">
          <div className="lp-brand">
            <span className="lp-mark" aria-hidden="true">
              {/* A ranked list: the whole product in one mark. */}
              <svg viewBox="0 0 16 16" fill="none">
                <rect x="1" y="2" width="14" height="3" rx="1.5" fill="currentColor" />
                <rect x="1" y="6.5" width="10" height="3" rx="1.5" fill="currentColor" opacity=".55" />
                <rect x="1" y="11" width="6" height="3" rx="1.5" fill="currentColor" opacity=".3" />
              </svg>
            </span>
            <span className="lp-wordmark">Shortlist</span>
          </div>

          <div className="lp-top-right">
            {authEnabled ? (
              <button className="lp-top-link" onClick={startGoogleLogin}>
                Sign in
              </button>
            ) : (
              <span className="lp-top-off">Sign-in unavailable</span>
            )}
          </div>
        </div>
      </header>

      <main className="lp-main">
        <section className={`lp-hero${demo ? '' : ' is-solo'}`}>
          <div className="lp-intro">
            <p className="lp-eyebrow">
              <span className="lp-dot" aria-hidden="true" />
              Job search copilot
            </p>

            <h1 className="lp-title">
              Every opening, <em>scored against your résumé.</em>
            </h1>

            <p className="lp-lede">
              Shortlist gathers roles from job boards and company career pages, scores
              each one against your résumé with an LLM, and drafts the outreach, so your
              evenings go to the handful actually worth applying to.
            </p>
          </div>

          {demo && (
            <aside className="lp-proof" aria-label="A real job, already scored">
              <article className="lp-card">
                <div className="lp-card-top">
                  <span className="lp-dot" aria-hidden="true" />
                  A real job, already scored
                  {demo.source && (
                    <span className="lp-src">
                      from <b>{demo.source}</b>
                    </span>
                  )}
                </div>

                <div className="lp-job">
                  <div
                    className={`lp-ring${high ? ' is-strong' : ''}`}
                    style={{ '--lp-p': demo.score ?? 0 } as CSSProperties}
                  >
                    <span className="lp-ring-num">{demo.score ?? '—'}</span>
                    <span className="lp-ring-cap">score</span>
                  </div>

                  <div>
                    <h2 className="lp-job-title">{demo.title}</h2>
                    <p className="lp-job-meta">
                      <b>{demo.company}</b>
                      {demo.location ? ` · ${demo.location}` : ''}
                    </p>
                  </div>
                </div>

                {(demo.salary || posted || demo.cvVariant) && (
                  <div className="lp-facts">
                    {demo.salary && (
                      <div className="lp-fact">
                        <div className="lp-fact-k">Salary</div>
                        <div className="lp-fact-v">{formatSalary(demo.salary)}</div>
                      </div>
                    )}
                    {posted && (
                      <div className="lp-fact">
                        <div className="lp-fact-k">Posted</div>
                        <div className="lp-fact-v">{posted}</div>
                      </div>
                    )}
                    {demo.cvVariant && (
                      <div className="lp-fact">
                        <div className="lp-fact-k">Suggested CV</div>
                        <div className="lp-fact-v">{demo.cvVariant}</div>
                      </div>
                    )}
                  </div>
                )}

                {demo.reason && (
                  <div className="lp-why">
                    <div className="lp-why-k">
                      {demo.score != null ? `Why it scored ${demo.score}` : 'Why'}
                    </div>
                    <p className="lp-why-t">{demo.reason}</p>
                  </div>
                )}

                <div className="lp-card-foot">
                  <p>
                    Scored against a generic sample résumé. Add your own and every role in
                    the pool gets scored against your background instead.
                  </p>
                  {demo.url && (
                    <a
                      className="lp-posting"
                      href={demo.url}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      See the posting ↗
                    </a>
                  )}
                </div>
              </article>
            </aside>
          )}

          <div className="lp-plan">
            <p className="lp-plan-head">What happens after you sign in</p>

            <ol className="lp-steps">
              {STEPS.map((s, i) => (
                <li key={s.lead} className="lp-step">
                  <span className="lp-step-n" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span>
                    <strong>{s.lead}</strong> {s.rest}
                  </span>
                </li>
              ))}
            </ol>

            {notice && <p className="lp-notice">{notice}</p>}

            {authEnabled ? (
              <>
                <button className="lp-cta" onClick={startGoogleLogin}>
                  Continue with Google
                  <span className="lp-cta-arrow" aria-hidden="true">
                    →
                  </span>
                </button>
                <p className="lp-cta-note">
                  Google's consent screen opens in this tab and brings you straight back.
                </p>
              </>
            ) : (
              <p className="lp-notice">
                Google sign-in is not configured on this server. Set{' '}
                <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code> and{' '}
                <code>SESSION_SECRET</code> in the backend .env.
              </p>
            )}

            <p className="lp-trust">
              <strong>You stay the send button.</strong> Shortlist writes the drafts and
              points you at who to contact, but nothing is ever sent or applied for on your
              behalf.
            </p>
          </div>
        </section>
      </main>

      <footer className="lp-foot">
        <div className="lp-foot-inner">
          <span className="lp-foot-k">Your data</span>
          <p className="lp-foot-t">
            We store your résumé text and job pipeline so the app can score roles for you.
            You can delete your account and all of its data at any time from the Profile tab.
          </p>
        </div>
      </footer>
    </div>
  )
}
