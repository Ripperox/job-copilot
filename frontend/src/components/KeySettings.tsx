import { useEffect, useState } from 'react'
import type { KeyStatus } from '../api'
import { UnauthorizedError, deleteKey, getKeyStatus, saveKey } from '../api'
import '../styles/profile.css'

const PROVIDERS = ['groq', 'gemini', 'anthropic'] as const

// Bring-your-own-key. The key is validated by the server against the provider
// before it is stored, encrypted at rest, and never sent back to the browser —
// we only ever display the mask the server returns.
export default function KeySettings({
  onUnauthorized,
  onChanged,
}: {
  onUnauthorized?: () => void
  onChanged?: (status: KeyStatus) => void
}) {
  const [status, setStatus] = useState<KeyStatus | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let active = true
    getKeyStatus()
      .then((s) => active && setStatus(s))
      .catch((err: unknown) => {
        if (!active) return
        if (err instanceof UnauthorizedError) return onUnauthorized?.()
        setError(err instanceof Error ? err.message : 'Could not load key status')
      })
    return () => {
      active = false
    }
  }, [onUnauthorized])

  async function handleSave() {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const next = await saveKey(input.trim())
      setStatus(next)
      setInput('')
      setSaved(true)
      onChanged?.(next)
      window.setTimeout(() => setSaved(false), 3000)
    } catch (err: unknown) {
      if (err instanceof UnauthorizedError) return onUnauthorized?.()
      setError(err instanceof Error ? err.message : 'Could not save key')
    } finally {
      setBusy(false)
    }
  }

  async function handleRemove() {
    setBusy(true)
    setError(null)
    try {
      const next = await deleteKey()
      setStatus(next)
      onChanged?.(next)
    } catch (err: unknown) {
      if (err instanceof UnauthorizedError) return onUnauthorized?.()
      setError(err instanceof Error ? err.message : 'Could not remove key')
    } finally {
      setBusy(false)
    }
  }

  const hasKey = status?.hasKey === true

  return (
    <section className="pf-sec">
      <h2 className="sec-title">Scoring key</h2>
      <p className="sec-sub">
        Shortlist scores every role against your résumé with an LLM, and it runs on{' '}
        <strong>your own API key</strong> — so the usage, the limits and the logs stay
        yours. Paste a key from Groq, Google Gemini or Anthropic and the server works out
        which it is.{' '}
        <a
          className="pf-link"
          href="https://console.groq.com/keys"
          target="_blank"
          rel="noreferrer"
        >
          Get a free Groq key →
        </a>{' '}
        (recommended — the most generous free tier by far)
      </p>

      {error && (
        <div className="pf-alert" role="alert">
          {error}
        </div>
      )}

      <div className="pf-keypanel">
        {/* Status line: provider + the server-side mask. The raw key never
            comes back from the server, so there is nothing else to show. */}
        <div className="pf-kp-head">
          <span className="pf-kp-headkey">Status</span>
          {hasKey ? (
            <>
              <span className="u-pill pf-st-on">{status?.provider ?? 'key'}</span>
              <code className="pf-mask">{status?.mask}</code>
              {saved && <span className="pf-saved">Updated</span>}
            </>
          ) : (
            <>
              <span className="u-pill pf-st-off">No key — keyword scoring</span>
              {/* Which providers the server can recognise — only worth showing
                  while there is nothing to detect yet. */}
              <span className="pf-providers">
                <span className="pf-prov-lead">Accepts</span>
                {PROVIDERS.map((p) => (
                  <span key={p} className="pf-prov">
                    {p}
                  </span>
                ))}
              </span>
            </>
          )}
        </div>

        {/* The trust story, as structure rather than reassurance. */}
        <div className="pf-led">
          <span className="pf-led-term">Validated</span>
          <span>
            Checked against the provider before it is accepted, so a typo fails here and
            not halfway through a scoring run.
          </span>
        </div>
        <div className="pf-led">
          <span className="pf-led-term">Encrypted</span>
          <span>Encrypted before it touches the database. Nothing is written in plain text.</span>
        </div>
        <div className="pf-led pf-led-keep">
          <span className="pf-led-term">Never shown again</span>
          <span>
            It is never returned to this browser — the {status?.mask ? 'mask above' : 'mask'} is
            all the server will hand back.
          </span>
        </div>

        <p className="pf-kp-note">
          {hasKey
            ? 'Replace it by pasting a new key below, or remove it to fall back to keyword-only scoring.'
            : 'No key yet — jobs are scored with a keyword heuristic, and outreach uses a template. Add a key to switch on real LLM scoring.'}
        </p>

        <div className="pf-keyform">
          <label className="pf-key pf-keylabel" htmlFor="pf-apikey">
            API key
          </label>
          <input
            id="pf-apikey"
            className="pf-input pf-keyinput"
            type="password"
            autoComplete="off"
            placeholder="Paste your Groq, Gemini or Anthropic API key"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button
            className="pf-btn pf-btn-go"
            onClick={handleSave}
            disabled={busy || !input.trim()}
          >
            {busy ? 'Checking…' : hasKey ? 'Replace key' : 'Save key'}
          </button>
          {hasKey && (
            <button className="pf-btn pf-btn-unset" onClick={handleRemove} disabled={busy}>
              Remove
            </button>
          )}
        </div>

        <p className="pf-foot">
          Your key is encrypted before it is stored and is never shown again after saving.
          It is used only to score jobs and draft outreach for your account.
        </p>
      </div>
    </section>
  )
}
