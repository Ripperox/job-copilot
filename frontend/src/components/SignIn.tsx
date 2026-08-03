import { useEffect, useState } from 'react'
import type { ScoredJob } from '../api'
import { getDemoJob, startGoogleLogin } from '../api'

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

  return (
    <div className="signin">
      <div className="signin-card">
        <div className="signin-brand">
          <span className="brand-mark">◆</span>
          <span className="brand-name">Job Copilot</span>
        </div>

        <h1 className="signin-title">Your job search, scored and tracked.</h1>
        <p className="signin-sub">
          Pulls roles from five sources, scores every one against your résumé, drafts the
          outreach, and tracks each application through the pipeline. You stay the send button.
        </p>

        {notice && <p className="signin-notice">{notice}</p>}

        {authEnabled ? (
          <button className="btn btn-primary signin-btn" onClick={startGoogleLogin}>
            Continue with Google
          </button>
        ) : (
          <p className="signin-notice">
            Google sign-in is not configured on this server. Set GOOGLE_CLIENT_ID,
            GOOGLE_CLIENT_SECRET and SESSION_SECRET in the backend .env.
          </p>
        )}

        {demo && (
          <div className="demo-block">
            <div className="demo-label">Live example — one real scored job</div>
            <div className="demo-job">
              <div className="demo-job-head">
                <span className={`demo-score ${demo.score != null && demo.score >= 70 ? 'demo-score-high' : ''}`}>
                  {demo.score ?? '—'}
                </span>
                <div>
                  <div className="demo-title">{demo.title}</div>
                  <div className="demo-company">
                    {demo.company} · {demo.location}
                  </div>
                </div>
              </div>
              {demo.reason && <p className="demo-reason">“{demo.reason}”</p>}
            </div>
            <p className="demo-foot">
              Sign in and add your résumé to score the whole pool against your own background.
            </p>
          </div>
        )}

        <p className="signin-fine">
          We store your résumé text and job pipeline so the app can score roles for you.
          You can delete your account and all of its data at any time from the Profile tab.
        </p>
      </div>
    </div>
  )
}
