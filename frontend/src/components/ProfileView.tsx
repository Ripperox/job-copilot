import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { Profile } from '../api'
import { UnauthorizedError, deleteAccount, getProfile, saveProfile } from '../api'
import KeySettings from './KeySettings'
import '../styles/profile.css'

const EMPTY: Profile = {
  resumeText: '',
  roles: [],
  locations: [],
  salaryFloorLPA: null,
  maxYoE: 3,
  mustHaves: [],
  cvVariants: [],
}

function toCsv(arr: string[]): string {
  return arr.join(', ')
}

function fromCsv(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

// One register of the config table: micro-label + syntax note in the left
// gutter, the control on the right. The whole row lights its left edge when
// anything inside it takes focus.
function Register({
  id,
  label,
  note,
  children,
}: {
  id: string
  label: string
  note: ReactNode
  children: ReactNode
}) {
  return (
    <div className="pf-row">
      <div className="pf-rowkey">
        <label className="pf-key" htmlFor={id}>
          {label}
        </label>
        <p className="pf-note">{note}</p>
      </div>
      <div className="pf-rowval">{children}</div>
    </div>
  )
}

// Echo the parsed list back, so the comma syntax has a visible consequence
// before you hit save. Same parser the save payload uses.
function Tokens({ value }: { value: string }) {
  const items = fromCsv(value)
  if (items.length === 0) return <p className="pf-tokens-empty">none set</p>
  return (
    <div className="pf-tokens">
      {items.map((item, i) => (
        <span className="pf-token" key={`${item}-${i}`}>
          {item}
        </span>
      ))}
    </div>
  )
}

export default function ProfileView({
  onUnauthorized,
  onAccountDeleted,
}: {
  onUnauthorized?: () => void
  onAccountDeleted?: () => void
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [resumeText, setResumeText] = useState('')
  const [roles, setRoles] = useState('')
  const [locations, setLocations] = useState('')
  const [mustHaves, setMustHaves] = useState('')
  const [cvVariants, setCvVariants] = useState('')
  const [salaryFloor, setSalaryFloor] = useState('')
  const [maxYoE, setMaxYoE] = useState('3')

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    getProfile()
      .then((profile) => {
        if (!active) return
        const p = profile ?? EMPTY
        setResumeText(p.resumeText ?? '')
        setRoles(toCsv(p.roles ?? []))
        setLocations(toCsv(p.locations ?? []))
        setMustHaves(toCsv(p.mustHaves ?? []))
        setCvVariants(toCsv(p.cvVariants ?? []))
        setSalaryFloor(p.salaryFloorLPA == null ? '' : String(p.salaryFloorLPA))
        setMaxYoE(p.maxYoE == null ? '3' : String(p.maxYoE))
      })
      .catch((err: unknown) => {
        if (!active) return
        if (err instanceof UnauthorizedError) return onUnauthorized?.()
        setError(err instanceof Error ? err.message : 'Failed to load profile')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  async function handleSave() {
    setSaving(true)
    setSaved(false)
    setError(null)
    const trimmedSalary = salaryFloor.trim()
    const payload: Profile = {
      resumeText,
      roles: fromCsv(roles),
      locations: fromCsv(locations),
      mustHaves: fromCsv(mustHaves),
      cvVariants: fromCsv(cvVariants),
      salaryFloorLPA: trimmedSalary === '' ? null : Number(trimmedSalary),
      maxYoE: maxYoE.trim() === '' ? null : Number(maxYoE),
    }
    try {
      const updated = await saveProfile(payload)
      // Reflect any normalization the server did.
      setResumeText(updated.resumeText ?? '')
      setRoles(toCsv(updated.roles ?? []))
      setLocations(toCsv(updated.locations ?? []))
      setMustHaves(toCsv(updated.mustHaves ?? []))
      setCvVariants(toCsv(updated.cvVariants ?? []))
      setSalaryFloor(
        updated.salaryFloorLPA == null ? '' : String(updated.salaryFloorLPA),
      )
      setMaxYoE(updated.maxYoE == null ? '3' : String(updated.maxYoE))
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2500)
    } catch (err: unknown) {
      if (err instanceof UnauthorizedError) return onUnauthorized?.()
      setError(err instanceof Error ? err.message : 'Failed to save profile')
    } finally {
      setSaving(false)
    }
  }

  async function handleDeleteAccount() {
    setDeleting(true)
    setError(null)
    try {
      await deleteAccount()
      onAccountDeleted?.()
    } catch (err: unknown) {
      if (err instanceof UnauthorizedError) return onUnauthorized?.()
      setError(err instanceof Error ? err.message : 'Failed to delete account')
    } finally {
      setDeleting(false)
    }
  }

  if (loading) {
    return (
      <div className="pf-boot" role="status">
        <span className="pf-boot-cmd">$ load profile</span>
        <span>Loading profile…</span>
        <span className="pf-caret" aria-hidden="true" />
      </div>
    )
  }

  // Readouts — derived from what is on screen, nothing fetched.
  const chars = resumeText.length
  const lines = resumeText.length === 0 ? 0 : resumeText.split('\n').length

  return (
    <div className="pf">
      <header>
        <div className="pf-masthead">
          <span className="pf-masthead-id">profile · config</span>
          <div className="pf-readout">
            <span className="pf-readout-cell">
              <span className="pf-readout-key">résumé</span>
              <span className="pf-readout-val">{chars.toLocaleString()}c</span>
            </span>
            <span className="pf-readout-cell">
              <span className="pf-readout-key">roles</span>
              <span className="pf-readout-val">{fromCsv(roles).length}</span>
            </span>
            <span className="pf-readout-cell">
              <span className="pf-readout-key">locations</span>
              <span className="pf-readout-val">{fromCsv(locations).length}</span>
            </span>
            <span className="pf-readout-cell">
              <span className="pf-readout-key">ceiling</span>
              <span className="pf-readout-val">
                {maxYoE.trim() === '' ? '—' : `${maxYoE.trim()}y`}
              </span>
            </span>
          </div>
        </div>
        <p className="pf-lede">
          This is what the copilot uses to score and match jobs for you.
        </p>
      </header>

      {error && (
        <div className="pf-alert" role="alert">
          <span className="pf-alert-tag">err</span>
          <span>{error}</span>
        </div>
      )}

      {/* ---- 01 résumé ------------------------------------------------- */}
      <section className="pf-sec">
        <div className="sec">
          <span className="sec-index">01</span>
          <span className="sec-rule" />
          <span className="sec-cmd">$ cat resume.txt</span>
        </div>
        <h2 className="sec-title">Résumé source</h2>
        <p className="sec-sub">
          The one document the scorer actually reads. Everything below only narrows
          the search; this is what every role gets compared against.
        </p>

        <div className="pf-doc corner-frame">
          <div className="pf-doc-bar">
            <label className="pf-doc-name" htmlFor="pf-resume">
              resume.txt
            </label>
            <div className="pf-doc-meta">
              <span className="pf-doc-meta-cell">
                chars <span className="pf-doc-meta-val">{chars.toLocaleString()}</span>
              </span>
              <span className="pf-doc-meta-cell">
                lines <span className="pf-doc-meta-val">{lines.toLocaleString()}</span>
              </span>
            </div>
          </div>
          <textarea
            id="pf-resume"
            className="pf-doc-area"
            rows={12}
            value={resumeText}
            placeholder="Paste your full resume text here…"
            onChange={(e) => setResumeText(e.target.value)}
          />
          <div className="pf-doc-foot">
            Plain text — bullets, stack, dates, numbers. Formatting is ignored, so paste
            the whole thing rather than a summary.
          </div>
        </div>
      </section>

      {/* ---- 02 match parameters --------------------------------------- */}
      <section className="pf-sec">
        <div className="sec">
          <span className="sec-index">02</span>
          <span className="sec-rule" />
          <span className="sec-cmd">$ set --match</span>
        </div>
        <h2 className="sec-title">Match parameters</h2>
        <p className="sec-sub">
          Filters applied before scoring. Lists are split on commas — the tokens under
          each field are exactly what gets stored.
        </p>

        <div className="pf-reg">
          <Register
            id="pf-roles"
            label="roles"
            note="Titles worth surfacing. e.g. Backend Engineer, Node.js Developer"
          >
            <input
              id="pf-roles"
              className="pf-input"
              value={roles}
              onChange={(e) => setRoles(e.target.value)}
            />
            <Tokens value={roles} />
          </Register>

          <Register
            id="pf-locations"
            label="locations"
            note="Where you will actually work. e.g. Bengaluru, Remote"
          >
            <input
              id="pf-locations"
              className="pf-input"
              value={locations}
              onChange={(e) => setLocations(e.target.value)}
            />
            <Tokens value={locations} />
          </Register>

          <Register
            id="pf-musthaves"
            label="must-haves"
            note="Deal-breakers. e.g. Remote, No on-call"
          >
            <input
              id="pf-musthaves"
              className="pf-input"
              value={mustHaves}
              onChange={(e) => setMustHaves(e.target.value)}
            />
            <Tokens value={mustHaves} />
          </Register>

          <Register
            id="pf-cvvariants"
            label="cv variants"
            note="Labels for the résumé versions you keep. e.g. Backend, Fullstack, Platform"
          >
            <input
              id="pf-cvvariants"
              className="pf-input"
              value={cvVariants}
              onChange={(e) => setCvVariants(e.target.value)}
            />
            <Tokens value={cvVariants} />
          </Register>

          <Register
            id="pf-maxyoe"
            label="experience ceiling"
            note={
              <>
                Roles asking for more — senior / lead / principal, or “N+ years” — are
                filtered out of your matches. 2–3 for a junior search.
              </>
            }
          >
            <span className="pf-num">
              <input
                id="pf-maxyoe"
                className="pf-input"
                type="number"
                min="0"
                max="20"
                step="1"
                value={maxYoE}
                onChange={(e) => setMaxYoE(e.target.value)}
              />
              <span className="pf-unit" aria-hidden="true">
                yrs
              </span>
            </span>
          </Register>

          <Register
            id="pf-salary"
            label="salary floor"
            note="Minimum acceptable, in lakhs per annum. Leave blank for none."
          >
            <span className="pf-num">
              <input
                id="pf-salary"
                className="pf-input"
                type="number"
                min="0"
                step="0.5"
                value={salaryFloor}
                onChange={(e) => setSalaryFloor(e.target.value)}
              />
              <span className="pf-unit" aria-hidden="true">
                lpa
              </span>
            </span>
          </Register>
        </div>

        <div className="pf-commit">
          <span className="pf-commit-note">
            Edits stay local until you save. The server normalises the lists and hands
            them straight back.
          </span>
          <div className="pf-commit-actions">
            {saved && <span className="pf-saved">Saved ✓</span>}
            <button
              className="pf-btn pf-btn-go"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Save profile'}
            </button>
          </div>
        </div>
      </section>

      {/* ---- 03 scoring key -------------------------------------------- */}
      <KeySettings onUnauthorized={onUnauthorized} />

      {/* ---- 04 danger zone -------------------------------------------- */}
      <section className="pf-sec pf-sec-danger">
        <div className="sec">
          <span className="sec-index">04</span>
          <span className="sec-rule" />
          <span className="sec-cmd">$ rm -rf --account</span>
        </div>
        <h2 className="sec-title">Danger zone</h2>
        <p className="sec-sub">
          Deleting your account permanently removes your résumé, scores, pipeline and
          outreach drafts. Shared job listings are not affected. This cannot be undone.
        </p>

        <div className={`pf-danger${confirmingDelete ? ' pf-danger-armed' : ''}`}>
          <div className="pf-led">
            <span className="pf-led-term">removed</span>
            <span>résumé · scores &amp; reasons · pipeline &amp; notes · outreach drafts</span>
          </div>
          <div className="pf-led pf-led-keep">
            <span className="pf-led-term">untouched</span>
            <span>shared job listings — those are not yours to delete</span>
          </div>

          <div className="pf-danger-act">
            {confirmingDelete ? (
              <>
                <span className="pf-danger-arm">
                  <span className="pf-danger-arm-cmd">confirm</span>
                  <span>Everything in the first row goes. There is no undo and no export.</span>
                </span>
                <button
                  className="pf-btn pf-btn-red pf-btn-red-armed"
                  onClick={handleDeleteAccount}
                  disabled={deleting}
                >
                  {deleting ? 'Deleting…' : 'Yes, delete everything'}
                </button>
                <button
                  className="pf-btn"
                  onClick={() => setConfirmingDelete(false)}
                  disabled={deleting}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                className="pf-btn pf-btn-red"
                onClick={() => setConfirmingDelete(true)}
              >
                Delete my account
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
