import { useEffect, useState } from 'react'
import type { KeyStatus } from '../api'
import { UnauthorizedError, deleteKey, getKeyStatus, saveKey } from '../api'
import '../styles/profile.css'

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
        Add a Groq, Gemini or Anthropic key to let the model read each posting and explain its score.
        <a className="pf-link" href="https://console.groq.com/keys" target="_blank" rel="noreferrer">
          Get a free Groq key →
        </a>
      </p>

      {error && <div className="pf-alert" role="alert">{error}</div>}

      <div className="pf-keypanel">
        <div className="pf-kp-head">
          <span className="pf-kp-headkey">Status</span>
          {hasKey ? (
            <>
              <span className="u-pill pf-st-on">{status?.provider ?? 'key'}</span>
              <code className="pf-mask">{status?.mask}</code>
              {saved && <span className="pf-saved">Updated</span>}
            </>
          ) : (
            <span className="u-pill pf-st-off">No key — keyword scoring only</span>
          )}
        </div>

        <p className="pf-kp-note">
          {hasKey
            ? 'Paste a new key below to replace, or remove to fall back to keyword matching.'
            : 'Without a key, roles are ranked by keyword overlap only — no written reasons.'}
        </p>

        <div className="pf-keyform">
          <label className="pf-key pf-keylabel" htmlFor="pf-apikey">API key</label>
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

        <p className="pf-foot">Your key is encrypted at rest and never shown again after saving.</p>
      </div>
    </section>
  )
}
