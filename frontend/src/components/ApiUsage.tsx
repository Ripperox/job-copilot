import { useEffect, useState } from 'react'
import type { UsageRow } from '../api'
import { getStatus } from '../api'
import '../styles/usage.css'

// What every API has spent, and what is left.
//
// The status panel below could say a provider was working or rate-limited, but
// never how close to the edge it was — so the first warning of a spent quota
// was everything stopping at once. This is the gauge that was missing.

const GROUPS: { kind: UsageRow['kind']; title: string; blurb: string }[] = [
  {
    kind: 'model',
    title: 'Scoring',
    blurb: 'Each posting is read and given a score with a reason. Whichever of these has room does the work; the rest stand by.',
  },
  {
    kind: 'jobs',
    title: 'Job sources',
    blurb: 'Where the postings come from. The metered ones are worth watching; the public boards cost nothing and carry most of the pool.',
  },
  {
    kind: 'scrape',
    title: 'Career pages',
    blurb: 'Company sites read directly, which is where the earliest roles show up.',
  },
]

function untilReset(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  if (!Number.isFinite(ms) || ms <= 0) return 'resetting now'
  const hours = Math.floor(ms / 3_600_000)
  if (hours < 1) return `resets in ${Math.max(1, Math.round(ms / 60_000))}m`
  if (hours < 48) return `resets in ${hours}h`
  return `resets in ${Math.round(hours / 24)}d`
}

// Green until it matters. Amber is "plan the rest of the day around this",
// red is "this will stop working shortly".
function band(fraction: number): 'ok' | 'warn' | 'bad' {
  if (fraction >= 0.9) return 'bad'
  if (fraction >= 0.7) return 'warn'
  return 'ok'
}

function Meter({ row }: { row: UsageRow }) {
  const uncapped = row.limit == null || row.fraction == null
  const pct = uncapped ? 0 : Math.round(row.fraction! * 100)
  const tone = uncapped ? 'none' : band(row.fraction!)

  return (
    <li className={`ug-row is-${tone}`}>
      <div className="ug-top">
        <span className="ug-name" title={row.note}>
          {row.label}
        </span>
        <span className="ug-count">
          {uncapped ? (
            <>
              <span className="u-num">{row.used.toLocaleString()}</span> calls
              <span className="ug-dim"> · no cap</span>
            </>
          ) : (
            <>
              <span className="u-num">{row.remaining!.toLocaleString()}</span> left
              <span className="ug-dim">
                {' '}
                of {row.limit!.toLocaleString()} / {row.window}
              </span>
            </>
          )}
        </span>
      </div>

      {uncapped ? (
        // No bar. A full-width bar for something with no ceiling would be a
        // decoration that reads as information.
        <p className="ug-note">{row.note}</p>
      ) : (
        <>
          <div
            className="ug-bar"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${row.label}: ${pct}% of the ${row.window}ly allowance used`}
          >
            <span className="ug-fill" style={{ width: `${pct}%` }} />
          </div>
          <p className="ug-note">
            <span className="u-num">{row.used.toLocaleString()}</span> used · {untilReset(row.resetsAt)}
          </p>
        </>
      )}
    </li>
  )
}

export default function ApiUsage() {
  const [rows, setRows] = useState<UsageRow[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    const load = () =>
      getStatus()
        .then((s) => {
          if (!active) return
          setRows(s.usage ?? [])
          setFailed(false)
        })
        .catch(() => active && setFailed(true))
    void load()
    // Slow poll. Nothing here changes between fetches, and a settings page has
    // no business holding a socket open.
    const t = window.setInterval(load, 60_000)
    return () => {
      active = false
      window.clearInterval(t)
    }
  }, [])

  if (failed) {
    return (
      <section className="ug">
        <h2 className="sec-title">Allowances</h2>
        <p className="sec-sub">Could not read usage. The backend may be down.</p>
      </section>
    )
  }

  if (!rows) {
    return (
      <section className="ug" aria-hidden="true">
        <h2 className="sec-title">Allowances</h2>
        <span className="u-skeleton ug-skel" />
        <span className="u-skeleton ug-skel" />
        <span className="u-skeleton ug-skel" />
      </section>
    )
  }

  return (
    <section className="ug">
      <h2 className="sec-title">Allowances</h2>
      <p className="sec-sub">
        Every outside service this runs on, and how much of it is left. Counted here as
        requests go out, so treat it as a close estimate — each provider's own billing
        page is the real number.
      </p>

      {GROUPS.map((g) => {
        const group = rows.filter((r) => r.kind === g.kind)
        if (!group.length) return null
        return (
          <div className="ug-group" key={g.kind}>
            <h3 className="ug-gtitle">{g.title}</h3>
            <p className="ug-gblurb">{g.blurb}</p>
            <ul className="ug-list">
              {group.map((r) => (
                <Meter row={r} key={r.name} />
              ))}
            </ul>
          </div>
        )
      })}
    </section>
  )
}
