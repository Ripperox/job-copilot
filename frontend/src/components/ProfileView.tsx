import { useEffect, useState } from 'react'
import type { Profile } from '../api'
import { getProfile, saveProfile } from '../api'

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

export default function ProfileView() {
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
        if (active) setError(err instanceof Error ? err.message : 'Failed to load profile')
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
      setError(err instanceof Error ? err.message : 'Failed to save profile')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <p className="muted">Loading profile…</p>
  }

  return (
    <div className="stack">
      <div className="card">
        <h2>Your profile</h2>
        <p className="muted">
          This is what the copilot uses to score and match jobs for you.
        </p>

        {error && <div className="banner banner-error">{error}</div>}

        <label className="field">
          <span className="field-label">Resume text</span>
          <textarea
            className="textarea"
            rows={12}
            value={resumeText}
            placeholder="Paste your full resume text here…"
            onChange={(e) => setResumeText(e.target.value)}
          />
        </label>

        <label className="field">
          <span className="field-label">Roles</span>
          <span className="hint">Comma-separated, e.g. Backend Engineer, Node.js Developer</span>
          <input
            className="input"
            value={roles}
            onChange={(e) => setRoles(e.target.value)}
          />
        </label>

        <label className="field">
          <span className="field-label">Locations</span>
          <span className="hint">Comma-separated, e.g. Bengaluru, Remote</span>
          <input
            className="input"
            value={locations}
            onChange={(e) => setLocations(e.target.value)}
          />
        </label>

        <label className="field field-narrow">
          <span className="field-label">Max years of experience</span>
          <span className="hint">
            Roles needing more than this (senior / lead / principal, or "N+ years")
            are filtered out of your matches. For a junior search, 2–3 is typical.
          </span>
          <input
            className="input"
            type="number"
            min="0"
            max="20"
            step="1"
            value={maxYoE}
            onChange={(e) => setMaxYoE(e.target.value)}
          />
        </label>

        <label className="field">
          <span className="field-label">Must-haves</span>
          <span className="hint">Comma-separated deal-breakers, e.g. Remote, No on-call</span>
          <input
            className="input"
            value={mustHaves}
            onChange={(e) => setMustHaves(e.target.value)}
          />
        </label>

        <label className="field">
          <span className="field-label">CV variants</span>
          <span className="hint">Comma-separated labels, e.g. Backend, Fullstack, Platform</span>
          <input
            className="input"
            value={cvVariants}
            onChange={(e) => setCvVariants(e.target.value)}
          />
        </label>

        <label className="field field-narrow">
          <span className="field-label">Salary floor (LPA)</span>
          <span className="hint">Minimum acceptable, in lakhs per annum. Leave blank for none.</span>
          <input
            className="input"
            type="number"
            min="0"
            step="0.5"
            value={salaryFloor}
            onChange={(e) => setSalaryFloor(e.target.value)}
          />
        </label>

        <div className="row">
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save profile'}
          </button>
          {saved && <span className="saved-note">Saved ✓</span>}
        </div>
      </div>
    </div>
  )
}
