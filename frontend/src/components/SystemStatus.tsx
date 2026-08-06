import { useEffect, useState } from 'react'
import { getStatus } from '../api'
import type { SystemStatus as Status, HealthRow, LlmRow } from '../api'
import '../styles/status.css'

// What is actually working right now.
//
// This exists because three job sources sat monthly-quota-dead for hours while
// the dashboard showed a healthy-looking pool of stale rows. Every failure went
// to stderr. Fetching, scoring and scraping all lean on third-party quotas that
// expire without warning, so "why did nothing new arrive?" needs an answer in
// the product rather than in a log tail.

const STATE_LABEL: Record<string, string> = {
  ok: 'Working',
  quota: 'Out of quota',
  auth: 'Key problem',
  error: 'Failing',
  idle: 'Not run yet',
  off: 'Not configured',
}

function ago(iso: string | null): string {
  if (!iso) return ''
  const secs = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000))
  if (secs < 90) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

/** "in 14m" — when a rate-limited provider says it will be usable again. */
function until(iso: string | null): string | null {
  if (!iso) return null
  const secs = Math.floor((Date.parse(iso) - Date.now()) / 1000)
  if (secs <= 0) return null
  if (secs < 90) return `in ${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `in ${mins}m`
  return `in ${Math.floor(mins / 60)}h`
}

function Row({
  name,
  state,
  detail,
  right,
  sub,
}: {
  name: string
  state: string
  detail?: string | null
  right?: string
  sub?: string | null
}) {
  return (
    <li className={`st-row st-${state}`}>
      <span className="st-dot" aria-hidden="true" />
      <span className="st-name">{name}</span>
      <span className="st-state">{STATE_LABEL[state] ?? state}</span>
      {right && <span className="st-num">{right}</span>}
      {(detail || sub) && (
        <span className="st-detail" title={detail ?? undefined}>
          {detail ?? sub}
        </span>
      )}
    </li>
  )
}

export default function SystemStatus() {
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let active = true
    const load = () =>
      getStatus()
        .then((s) => active && (setStatus(s), setError(false)))
        .catch(() => active && setError(true))
    void load()
    // Slow poll. Quotas change on the scale of minutes to hours, so anything
    // faster is just load for the sake of a moving number.
    const id = window.setInterval(load, 60_000)
    return () => {
      active = false
      window.clearInterval(id)
    }
  }, [])

  if (error) {
    return (
      <section className="st">
        <p className="st-lede">Could not read system status.</p>
      </section>
    )
  }
  if (!status) {
    return (
      <section className="st">
        <p className="st-lede">Checking sources…</p>
      </section>
    )
  }

  const jobs = status.jobSources
  const live = jobs.filter((s) => s.state === 'ok').length
  const broken = jobs.filter((s) => s.state === 'quota' || s.state === 'auth' || s.state === 'error')
  const llmLive = status.llm.filter((l) => l.state === 'ok' || l.state === 'idle')
  const llmDown = status.llm.filter((l) => l.configured && (l.state === 'quota' || l.state === 'auth'))

  return (
    <section className="st">
      <header className="st-head">
        <h3 className="st-h">Sources</h3>
        {/* The headline is the one sentence worth reading. Everything below is
            for when the answer is "some of them". */}
        <p className="st-lede">
          <span className="st-num">{live}</span> of{' '}
          <span className="st-num">{jobs.filter((s) => s.configured).length}</span> job sources
          working
          {broken.length > 0 && (
            <>
              {' · '}
              <span className="st-warn">
                {broken.length} {broken.length === 1 ? 'is' : 'are'} not
              </span>
            </>
          )}
          {llmDown.length > 0 && llmLive.length === 0 && (
            <>
              {' · '}
              <span className="st-warn">no model available — scoring falls back to keywords</span>
            </>
          )}
        </p>
        <button
          type="button"
          className="st-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? 'Hide detail' : 'Show detail'}
        </button>
      </header>

      {open && (
        <div className="st-body">
          <h4 className="st-sub">Job sources</h4>
          <ul className="st-list">
            {jobs.map((s: HealthRow) => (
              <Row
                key={s.name}
                name={s.name}
                state={s.state}
                detail={s.detail}
                right={s.inPool ? `${s.inPool} in pool` : undefined}
                sub={s.checkedAt ? `last run ${ago(s.checkedAt)}` : null}
              />
            ))}
          </ul>

          <h4 className="st-sub">Models</h4>
          <p className="st-note">
            Tried in order. A provider that runs out is skipped for the rest of the run, and
            scoring degrades to keyword matching only when every one is spent.
          </p>
          <ul className="st-list">
            {status.llm.map((l: LlmRow) => (
              <Row
                key={l.name}
                name={l.order ? `${l.order}. ${l.name}` : l.name}
                state={l.state}
                detail={l.detail}
                sub={until(l.retryAfter) ? `back ${until(l.retryAfter)}` : l.checkedAt ? `used ${ago(l.checkedAt)}` : null}
              />
            ))}
          </ul>

          <h4 className="st-sub">Career-page queue</h4>
          {status.queue ? (
            <p className="st-note">
              <span className="st-num">{status.queue.enabled}</span> targets ·{' '}
              <span className="st-num">{status.queue.dueNow}</span> due now ·{' '}
              <span className="st-num">{status.queue.producing}</span> have ever yielded ·{' '}
              <span className="st-num">{status.queue.neverScraped}</span> never visited
            </p>
          ) : (
            <p className="st-note">Queue unavailable.</p>
          )}

          <h4 className="st-sub">Scrapers</h4>
          <ul className="st-list">
            {status.scrapers.map((s) => (
              <Row key={s.name} name={s.name} state={s.configured ? 'ok' : 'off'} />
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
