import SystemStatus from './SystemStatus'
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

// One setting: name and explanation on the left, the control on the right.
// The ordinary shape of settings in a well-made product.
function Setting({
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
  if (items.length === 0) return <p className="pf-tokens-empty">Nothing set yet</p>
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
      <div className="pf-loading" role="status">
        <span className="live-dot" aria-hidden="true" />
        Loading your profile…
      </div>
    )
  }

  // Counts, derived from what is on screen — nothing fetched.
  const chars = resumeText.length
  const lines = resumeText.length === 0 ? 0 : resumeText.split('\n').length

  return (
    <div className="pf">
      <header className="pf-head">
        <h1 className="pf-h1">Profile</h1>
        <p className="pf-lede">
          This is what Job Copilot uses to score and match jobs for you. Your résumé
          is what every role gets compared against; everything else narrows the
          search.
        </p>
      </header>

      {error && (
        <div className="pf-alert" role="alert">
          {error}
        </div>
      )}

      <section className="pf-sec">
        <h2 className="sec-title">Your résumé</h2>
        <p className="sec-sub">
          The one document the scorer actually reads. Paste the whole thing rather
          than a summary — bullets, stack, dates, numbers. Formatting is ignored.
        </p>

        <div className="pf-doc">
          <div className="pf-doc-bar">
            <label className="pf-doc-name" htmlFor="pf-resume">
              Résumé text
            </label>
            <p className="pf-doc-meta">
              <span className="u-num">{chars.toLocaleString()}</span> characters
              {' · '}
              <span className="u-num">{lines.toLocaleString()}</span> lines
            </p>
          </div>
          <textarea
            id="pf-resume"
            className="pf-doc-area"
            rows={12}
            value={resumeText}
            placeholder="Paste your full resume text here…"
            onChange={(e) => setResumeText(e.target.value)}
          />
        </div>
      </section>

      <section className="pf-sec">
        <h2 className="sec-title">Matching preferences</h2>
        <p className="sec-sub">
          Filters applied before scoring. Lists are separated by commas — the chips
          under each field are exactly what gets stored.
        </p>

        <div className="pf-reg">
          <Setting
            id="pf-roles"
            label="Roles"
            note="Titles worth surfacing. For example: Backend Engineer, Node.js Developer"
          >
            <input
              id="pf-roles"
              className="pf-input"
              value={roles}
              onChange={(e) => setRoles(e.target.value)}
            />
            <Tokens value={roles} />
          </Setting>

          <Setting
            id="pf-locations"
            label="Locations"
            note="Where you will actually work. For example: Bengaluru, Remote"
          >
            <input
              id="pf-locations"
              className="pf-input"
              value={locations}
              onChange={(e) => setLocations(e.target.value)}
            />
            <Tokens value={locations} />
          </Setting>

          <Setting
            id="pf-musthaves"
            label="Must-haves"
            note="Deal-breakers. For example: Remote, No on-call"
          >
            <input
              id="pf-musthaves"
              className="pf-input"
              value={mustHaves}
              onChange={(e) => setMustHaves(e.target.value)}
            />
            <Tokens value={mustHaves} />
          </Setting>

          <Setting
            id="pf-cvvariants"
            label="CV variants"
            note="Labels for the résumé versions you keep. For example: Backend, Fullstack, Platform"
          >
            <input
              id="pf-cvvariants"
              className="pf-input"
              value={cvVariants}
              onChange={(e) => setCvVariants(e.target.value)}
            />
            <Tokens value={cvVariants} />
          </Setting>

          <Setting
            id="pf-maxyoe"
            label="Experience ceiling"
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
                years
              </span>
            </span>
          </Setting>

          <Setting
            id="pf-salary"
            label="Salary floor"
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
                LPA
              </span>
            </span>
          </Setting>
        </div>

        <div className="pf-commit">
          <p className="pf-commit-note">
            Edits stay on this page until you save. The server tidies up the lists and
            hands them straight back.
          </p>
          <div className="pf-commit-actions">
            {saved && <span className="pf-saved">Saved</span>}
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

      <KeySettings onUnauthorized={onUnauthorized} />

      <section className="pf-sec pf-sec-danger">
        <h2 className="sec-title">Delete account</h2>
        <p className="sec-sub">
          Deleting your account permanently removes your résumé, scores, pipeline and
          outreach drafts. Shared job listings are not affected. This cannot be undone.
        </p>

        <div className={`pf-danger${confirmingDelete ? ' pf-danger-armed' : ''}`}>
          <div className="pf-led">
            <span className="pf-led-term">Deleted</span>
            <span>Your résumé, scores and reasons, pipeline and notes, outreach drafts</span>
          </div>
          <div className="pf-led pf-led-keep">
            <span className="pf-led-term">Kept</span>
            <span>Shared job listings — those are not yours to delete</span>
          </div>

          <div className="pf-danger-act">
            {confirmingDelete ? (
              <>
                <p className="pf-danger-arm">
                  Everything in the first row goes. There is no undo and no export.
                </p>
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
            <SystemStatus />
</section>
    </div>
  )
}
