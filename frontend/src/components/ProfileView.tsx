import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import SystemStatus from './SystemStatus'
import ApiUsage from './ApiUsage'
import { ACCEPTED, ResumeFileError, readResumeFile } from '../lib/resume-file'
import type { Profile } from '../api'
import { UnauthorizedError, deleteAccount, getProfile, saveProfile } from '../api'
import KeySettings from './KeySettings'
import '../styles/profile.css'

const EMPTY: Profile = {
  resumeText: '',
  roles: [],
  locations: [],
  salaryFloor: { amount: null, currency: 'INR', period: 'year' },
  maxYoE: 3,
  mustHaves: [],
  cvVariants: [],
}

function TagInput({
  id,
  placeholder,
  tags,
  onChange,
}: {
  id: string
  placeholder: string
  tags: string[]
  onChange: (tags: string[]) => void
}) {
  const [input, setInput] = useState('')

  const addTag = (text: string) => {
    const split = text
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
    if (split.length === 0) return
    const next = Array.from(new Set([...tags, ...split]))
    onChange(next)
    setInput('')
  }

  const removeTag = (idx: number) => {
    onChange(tags.filter((_, i) => i !== idx))
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      addTag(input)
    } else if (e.key === 'Backspace' && !input && tags.length > 0) {
      removeTag(tags.length - 1)
    }
  }

  return (
    <div className="pf-tag-box" onClick={(e) => (e.currentTarget.querySelector('input') as HTMLElement)?.focus()}>
      <div className="pf-tag-list">
        {tags.map((tag, i) => (
          <span key={`${tag}-${i}`} className="pf-tag-chip">
            <span className="pf-tag-text">{tag}</span>
            <button
              type="button"
              className="pf-tag-del"
              onClick={(e) => {
                e.stopPropagation()
                removeTag(i)
              }}
              title={`Remove ${tag}`}
              aria-label={`Remove ${tag}`}
            >
              ×
            </button>
          </span>
        ))}
        <input
          id={id}
          className="pf-tag-input"
          value={input}
          placeholder={tags.length === 0 ? placeholder : 'Add more…'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            if (input.trim()) addTag(input)
          }}
        />
      </div>
      <div className="pf-tag-footer">
        <p className="pf-tag-hint">Press Enter or comma to add</p>
        <span className="pf-tag-count u-num">{tags.length}</span>
      </div>
    </div>
  )
}

function Setting({
  id,
  label,
  note,
  children,
  required,
}: {
  id: string
  label: string
  note: ReactNode
  children: ReactNode
  required?: boolean
}) {
  return (
    <div className="pf-row">
      <div className="pf-rowkey">
        <label className="pf-key" htmlFor={id}>
          {label}
          {required && <span className="pf-req" aria-label="Required">*</span>}
        </label>
        <div className="pf-note">{note}</div>
      </div>
      <div className="pf-rowval">{children}</div>
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
  const fileInput = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [reading, setReading] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [resumeFileName, setResumeFileName] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const [roles, setRoles] = useState<string[]>([])
  const [locations, setLocations] = useState<string[]>([])
  const [mustHaves, setMustHaves] = useState<string[]>([])
  const [cvVariants, setCvVariants] = useState<string[]>([])
  // Salary floor is a structured {amount, currency, period}. The amount is kept
  // as a string in state so an empty field stays editable ("17.5" typed as
  // "17." is not yet a number) and is parsed only on save.
  const [salaryAmount, setSalaryAmount] = useState('')
  const [salaryCurrency, setSalaryCurrency] = useState('INR')
  const [salaryPeriod, setSalaryPeriod] = useState<'year' | 'month' | 'hour'>('year')
  const [maxYoE, setMaxYoE] = useState('3')

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [isDirty, setIsDirty] = useState(false)

  // Track which required fields are filled for the completion indicator
  const requiredFilled = useMemo(() => ({
    resume: resumeText.trim().length > 0,
    roles: roles.length > 0,
    locations: locations.length > 0,
  }), [resumeText, roles, locations])

  const currencySymbol = useMemo(() => {
    const symbols: Record<string, string> = { INR: '₹', USD: '$', EUR: '€', GBP: '£' }
    return symbols[salaryCurrency] || salaryCurrency
  }, [salaryCurrency])

  const requiredCount = useMemo(() => 
    Object.values(requiredFilled).filter(Boolean).length, [requiredFilled])

  // Format salary amount with commas on blur for readability
  const formatSalaryAmount = (val: string) => {
    const num = Number(val.replace(/[, ]/g, ''))
    return Number.isFinite(num) ? num.toLocaleString() : val
  }

  async function loadResumeFile(file: File) {
    setReading(true)
    setFileError(null)
    try {
      const text = await readResumeFile(file)
      setResumeText(text)
      setResumeFileName(file.name)
      setIsDirty(true)
    } catch (err: unknown) {
      setResumeFileName(null)
      setFileError(
        err instanceof ResumeFileError
          ? err.message
          : 'Could not read that file. Paste the text below instead.',
      )
    } finally {
      setReading(false)
    }
  }

  useEffect(() => {
    let active = true
    getProfile()
      .then((p) => {
        if (!active) return
        const prof = p ?? EMPTY
        setResumeText(prof.resumeText ?? '')
        setRoles(prof.roles ?? [])
        setLocations(prof.locations ?? [])
        setMustHaves(prof.mustHaves ?? [])
        setCvVariants(prof.cvVariants ?? [])
        const sf = prof.salaryFloor ?? { amount: null, currency: 'INR', period: 'year' }
        setSalaryAmount(sf.amount != null ? String(sf.amount) : '')
        setSalaryCurrency(sf.currency || 'INR')
        setSalaryPeriod(sf.period === 'month' || sf.period === 'hour' ? sf.period : 'year')
        setMaxYoE(
          prof.maxYoE !== null && prof.maxYoE !== undefined ? String(prof.maxYoE) : '3',
        )
      })
      .catch((err: unknown) => {
        if (err instanceof UnauthorizedError) onUnauthorized?.()
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [onUnauthorized])

  const handleSave = useCallback(async () => {
    setSaving(true)
    setSaved(false)
    const yoe = parseInt(maxYoE, 10)
    const parsed = Number(salaryAmount.replace(/[, ]/g, ''))
    const profile: Profile = {
      resumeText,
      roles,
      locations,
      mustHaves,
      cvVariants,
      salaryFloor: {
        amount: salaryAmount.trim() !== '' && Number.isFinite(parsed) ? parsed : null,
        currency: salaryCurrency,
        period: salaryPeriod,
      },
      maxYoE: Number.isFinite(yoe) && yoe >= 0 ? yoe : null,
    }
    try {
      await saveProfile(profile)
      setSaved(true)
      setIsDirty(false)
      setTimeout(() => setSaved(false), 3500)
    } catch (err: unknown) {
      if (err instanceof UnauthorizedError) onUnauthorized?.()
    } finally {
      setSaving(false)
    }
  }, [resumeText, roles, locations, mustHaves, cvVariants, salaryAmount, salaryCurrency, salaryPeriod, maxYoE, onUnauthorized])

  // Keyboard shortcut Cmd+S / Ctrl+S to save
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        void handleSave()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleSave])

  async function handleDeleteAccount() {
    setDeleting(true)
    try {
      await deleteAccount()
      onAccountDeleted?.()
    } catch (err: unknown) {
      if (err instanceof UnauthorizedError) onUnauthorized?.()
      setDeleting(false)
    }
  }

  const copyResume = () => {
    if (!resumeText) return
    navigator.clipboard.writeText(resumeText)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (loading) {
    return (
      <div className="pf-app">
        <div className="pf-skel-wrap">
          <div className="u-skeleton pf-skel pf-skel-h" />
          <div className="u-skeleton pf-skel pf-skel-box" />
          <div className="u-skeleton pf-skel pf-skel-box" />
        </div>
      </div>
    )
  }

  const chars = resumeText.trim().length
  const lines = resumeText ? resumeText.split('\n').length : 0

  return (
    <div className="pf-app">
      {/* Sticky Save Bar */}
      <div className={`pf-floating-bar${isDirty || saved || requiredCount < 3 ? ' is-visible' : ''}`}>
        <div className="pf-floating-inner">
          <span className="pf-floating-text">
            {saved ? (
              <span className="pf-saved-badge">
                <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M3 8.5l3.5 3.5L13 4" />
                </svg>
                Changes saved
              </span>
            ) : isDirty ? (
              'Unsaved profile changes'
            ) : (
              <>
                <span className="pf-completion">
                  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M3 8.5l3.5 3.5L13 4" />
                  </svg>
                  Profile {requiredCount}/3 required — {requiredCount === 3 ? 'Ready to match' : 'Incomplete'}
                </span>
              </>
            )}
          </span>
          <div className="pf-floating-acts">
            <span className="pf-kbd-hint">⌘S to save</span>
            <button
              type="button"
              className="pf-btn pf-btn-go pf-btn-save-sm"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Save profile'}
            </button>
          </div>
        </div>
      </div>

      {/* Profile Summary — what drives matching */}
      <section className="pf-sec pf-summary" aria-label="What drives your matches">
        <div className="pf-summary-grid">
          <div className="pf-summary-item">
            <span className="pf-summary-label">Résumé</span>
            <span className={resumeText.trim() ? 'pf-summary-val pf-summary-ok' : 'pf-summary-val pf-summary-missing'}>
              {resumeText.trim() ? `${chars.toLocaleString()} chars` : 'Not set'}
            </span>
          </div>
          <div className="pf-summary-item">
            <span className="pf-summary-label">Target Roles</span>
            <span className={roles.length ? 'pf-summary-val pf-summary-ok' : 'pf-summary-val pf-summary-missing'}>
              {roles.length ? roles.join(', ') : 'Not set'}
            </span>
          </div>
          <div className="pf-summary-item">
            <span className="pf-summary-label">Locations</span>
            <span className={locations.length ? 'pf-summary-val pf-summary-ok' : 'pf-summary-val pf-summary-missing'}>
              {locations.length ? locations.join(', ') : 'Not set'}
            </span>
          </div>
          <div className="pf-summary-item">
            <span className="pf-summary-label">Salary Floor</span>
            <span className={salaryAmount.trim() ? 'pf-summary-val pf-summary-ok' : 'pf-summary-val pf-summary-missing'}>
              {salaryAmount.trim() ? `${currencySymbol}${Number(salaryAmount.replace(/[, ]/g, '')).toLocaleString()} per ${salaryPeriod}` : 'Not set'}
            </span>
          </div>
          <div className="pf-summary-item">
            <span className="pf-summary-label">Experience Ceiling</span>
            <span className={maxYoE.trim() ? 'pf-summary-val pf-summary-ok' : 'pf-summary-val pf-summary-missing'}>
              {maxYoE.trim() ? `${maxYoE} years max` : 'Not set'}
            </span>
          </div>
          <div className="pf-summary-item">
            <span className="pf-summary-label">Must-Haves</span>
            <span className={mustHaves.length ? 'pf-summary-val pf-summary-ok' : 'pf-summary-val pf-summary-missing'}>
              {mustHaves.length ? mustHaves.join(', ') : 'Not set'}
            </span>
          </div>
          <div className="pf-summary-item">
            <span className="pf-summary-label">CV Variants</span>
            <span className={cvVariants.length ? 'pf-summary-val pf-summary-ok' : 'pf-summary-val pf-summary-missing'}>
              {cvVariants.length ? cvVariants.join(', ') : 'Using defaults'}
            </span>
          </div>
        </div>
        <p className="pf-summary-hint">
          Every job is scored against all of the above. Missing fields are treated as "no
          preference" — you will see more roles, but less targeted matches.
        </p>
      </section>

      {/* Section 1: Résumé */}
      <section className="pf-sec">
        <div className="pf-sec-head">
          <div>
            <h2 className="sec-title">Your Résumé</h2>
            <p className="sec-sub">
              Upload your PDF or paste your résumé. Every job is scored against this exact text.
            </p>
          </div>
          {chars > 0 && (
            <span className="pf-badge pf-badge-ok">
              <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M3 8.5l3.5 3.5L13 4" />
              </svg>
              Active ({chars.toLocaleString()} chars)
            </span>
          )}
        </div>

        <div
          className={`pf-drop${dragging ? ' is-over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            const f = e.dataTransfer.files?.[0]
            if (f) void loadResumeFile(f)
          }}
        >
          <div className="pf-drop-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </div>
          <div className="pf-drop-info">
            <input
              ref={fileInput}
              type="file"
              accept={ACCEPTED}
              className="pf-drop-input"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void loadResumeFile(f)
                e.target.value = ''
              }}
            />
            <button
              type="button"
              className="pf-drop-btn"
              onClick={() => fileInput.current?.click()}
              disabled={reading}
            >
              {reading ? 'Parsing file…' : 'Upload PDF or text'}
            </button>
            <p className="pf-drop-hint">
              Drag and drop your file here · PDF, TXT or Markdown
              {resumeFileName && !reading && (
                <span className="pf-file-pill">
                  <span className="u-mono">{resumeFileName}</span>
                </span>
              )}
            </p>
          </div>
        </div>

        {fileError && (
          <div className="pf-drop-err" role="alert">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
              <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 3.5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0V5.25A.75.75 0 0 1 8 4.5zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2z" />
            </svg>
            <span>{fileError}</span>
          </div>
        )}

        <div className="pf-doc">
          <div className="pf-doc-bar">
            <label className="pf-doc-name" htmlFor="pf-resume">
              Parsed text content
            </label>
            <div className="pf-doc-actions">
              {chars > 0 && (
                <button type="button" className="pf-btn-ghost-sm" onClick={copyResume}>
                  {copied ? 'Copied ✓' : 'Copy text'}
                </button>
              )}
              <span className="pf-doc-meta">
                <span className="u-num">{chars.toLocaleString()}</span> chars ·{' '}
                <span className="u-num">{lines.toLocaleString()}</span> lines
              </span>
            </div>
          </div>
          <textarea
            id="pf-resume"
            className="pf-doc-area"
            rows={10}
            value={resumeText}
            placeholder="Paste your résumé text here or upload above. Edits are saved automatically to your profile."
            onChange={(e) => {
              setResumeText(e.target.value)
              setIsDirty(true)
            }}
          />
        </div>
      </section>

      {/* Section 2: Matching Preferences */}
      <section className="pf-sec">
        <div className="pf-sec-head">
          <div>
            <h2 className="sec-title">Matching Preferences</h2>
            <p className="sec-sub">
              Target titles, locations, and hard filters applied before relevance scoring.
            </p>
          </div>
        </div>

        <div className="pf-reg">
          <Setting
            id="pf-roles"
            label="Target Roles"
            note="Titles to surface. Jobs matching these titles receive prioritized scoring."
            required
          >
            <TagInput
              id="pf-roles"
              placeholder="e.g. Backend Engineer, Distributed Systems, Fullstack"
              tags={roles}
              onChange={(t) => {
                setRoles(t)
                setIsDirty(true)
              }}
            />
          </Setting>

          <Setting
            id="pf-locations"
            label="Preferred Locations"
            note="Where you want to work. Include Remote and cities you'd relocate to."
            required
          >
            <TagInput
              id="pf-locations"
              placeholder="e.g. Bengaluru, Remote, Mumbai, Hybrid"
              tags={locations}
              onChange={(t) => {
                setLocations(t)
                setIsDirty(true)
              }}
            />
          </Setting>

          <Setting
            id="pf-musthaves"
            label="Must-Haves / Deal-Breakers"
            note="Hard criteria. Postings violating these will be filtered out."
          >
            <TagInput
              id="pf-musthaves"
              placeholder="e.g. Remote, No On-Call, Product Startup"
              tags={mustHaves}
              onChange={(t) => {
                setMustHaves(t)
                setIsDirty(true)
              }}
            />
          </Setting>

          <Setting
            id="pf-cvvariants"
            label="CV Tag Variants"
            note="Labels for different positioning angles (e.g. Systems, AI Infra)."
          >
            <TagInput
              id="pf-cvvariants"
              placeholder="e.g. Backend, Systems, AI-Infra"
              tags={cvVariants}
              onChange={(t) => {
                setCvVariants(t)
                setIsDirty(true)
              }}
            />
          </Setting>

          <Setting
            id="pf-maxyoe"
            label="Experience Ceiling"
            note="Roles asking for more YoE (e.g. Lead, Staff) are filtered out."
          >
            <span className="pf-num-control">
              <input
                id="pf-maxyoe"
                className="pf-input pf-num-input"
                type="number"
                min="0"
                max="20"
                step="1"
                value={maxYoE}
                onChange={(e) => {
                  setMaxYoE(e.target.value)
                  setIsDirty(true)
                }}
              />
              <span className="pf-unit-badge">Years max</span>
            </span>
          </Setting>

          <Setting
            id="pf-salary"
            label="Salary floor"
            note="Minimum acceptable pay — anything you won't take."
          >
            <span className="pf-salary">
              <span className="pf-num-control">
                <input
                  id="pf-salary"
                  className="pf-input pf-num-input"
                  type="number"
                  min="0"
                  step="any"
                  placeholder="e.g. 1500000"
                  value={salaryAmount}
                  onChange={(e) => {
                    setSalaryAmount(e.target.value)
                    setIsDirty(true)
                  }}
                  onBlur={(e) => {
                    const formatted = formatSalaryAmount(e.target.value)
                    if (formatted !== e.target.value) setSalaryAmount(formatted)
                  }}
                />
                {salaryAmount && (
                  <button
                    type="button"
                    className="pf-clear-btn"
                    aria-label="Clear salary floor"
                    onClick={() => {
                      setSalaryAmount('')
                      setIsDirty(true)
                    }}
                  >
                    ×
                  </button>
                )}
              </span>
              <select
                className="pf-input pf-currency"
                aria-label="Salary currency"
                value={salaryCurrency}
                onChange={(e) => {
                  setSalaryCurrency(e.target.value)
                  setIsDirty(true)
                }}
              >
                <option value="INR">₹ INR</option>
                <option value="USD">$ USD</option>
                <option value="EUR">€ EUR</option>
                <option value="GBP">£ GBP</option>
              </select>
              <span className="pf-seg" role="group" aria-label="Salary period">
                {(['year', 'month', 'hour'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={`pf-seg-btn${salaryPeriod === p ? ' is-on' : ''}`}
                    aria-pressed={salaryPeriod === p}
                    onClick={() => {
                      setSalaryPeriod(p)
                      setIsDirty(true)
                    }}
                  >
                    {p === 'year' ? 'per year' : p === 'month' ? 'per month' : 'per hour'}
                  </button>
                ))}
              </span>
            </span>
          </Setting>
        </div>

        <div className="pf-commit">
          <p className="pf-commit-note">
            Saving updates your matching parameters immediately across your pipeline.
          </p>
          <div className="pf-commit-actions">
            {saved && (
              <span className="pf-saved">
                <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M3 8.5l3.5 3.5L13 4" />
                </svg>
                Saved
              </span>
            )}
            <button
              type="button"
              className="pf-btn pf-btn-go"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Save profile'}
            </button>
          </div>
        </div>
      </section>

      {/* Section 3: AI Scoring Keys */}
      <KeySettings onUnauthorized={onUnauthorized} />

      {/* Section 4: System Usage & Telemetry */}
      <section className="pf-sec">
        <ApiUsage />
      </section>

      <section className="pf-sec">
        <SystemStatus />
      </section>

      {/* Section 5: Account Danger Zone */}
      <section className="pf-sec pf-sec-danger">
        <h2 className="sec-title">Delete account</h2>
        <p className="sec-sub">
          Permanently removes your résumé, score evaluations, pipeline and drafts. Shared job listings remain unaffected.
        </p>

        <div className={`pf-danger${confirmingDelete ? ' pf-danger-armed' : ''}`}>
          <div className="pf-led">
            <span className="pf-led-term">Deleted</span>
            <span>Your résumé, match scores, saved job state, outreach drafts</span>
          </div>
          <div className="pf-led pf-led-keep">
            <span className="pf-led-term">Preserved</span>
            <span>Shared job aggregator pool</span>
          </div>

          <div className="pf-danger-act">
            {confirmingDelete ? (
              <>
                <p className="pf-danger-arm">
                  This action is permanent and cannot be undone.
                </p>
                <button
                  type="button"
                  className="pf-btn pf-btn-red pf-btn-red-armed"
                  onClick={handleDeleteAccount}
                  disabled={deleting}
                >
                  {deleting ? 'Deleting…' : 'Confirm Delete Everything'}
                </button>
                <button
                  type="button"
                  className="pf-btn"
                  onClick={() => setConfirmingDelete(false)}
                  disabled={deleting}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
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
