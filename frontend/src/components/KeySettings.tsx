import { useEffect, useState } from 'react'
import type { KeyStatus } from '../api'
import { UnauthorizedError, deleteKey, getKeyStatus, saveKey } from '../api'

// Bring-your-own-key. The key is validated by the server against Gemini before
// it is stored, encrypted at rest, and never sent back to the browser — we only
// ever display the mask the server returns.
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

  return (
    <div className="card">
      <h2>Scoring key</h2>
      <p className="muted">
        Job Copilot scores every role against your résumé with an LLM. Scoring runs on{' '}
        <strong>your own API key</strong>, so your usage stays yours. Paste a key from Groq,
        Google Gemini or Anthropic — we detect which it is.{' '}
        <a className="link" href="https://console.groq.com/keys" target="_blank" rel="noreferrer">
          Get a free Groq key →
        </a>{' '}
        <span className="hint-inline">(recommended — the most generous free tier by far)</span>
      </p>

      {error && <div className="banner banner-error">{error}</div>}

      {status?.hasKey ? (
        <>
          <div className="key-row">
            <span className="key-chip">{status.provider ?? "key"} · {status.mask}</span>
            {saved && <span className="saved-note">Updated ✓</span>}
          </div>
          <p className="hint">
            Replace it by pasting a new key below, or remove it to fall back to keyword-only
            scoring.
          </p>
        </>
      ) : (
        <p className="hint">
          No key yet — jobs are scored with a keyword heuristic, and outreach uses a template.
          Add a key to switch on real LLM scoring.
        </p>
      )}

      <div className="row key-form">
        <input
          className="input"
          type="password"
          autoComplete="off"
          placeholder="Paste your Groq, Gemini or Anthropic API key"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button className="btn btn-primary" onClick={handleSave} disabled={busy || !input.trim()}>
          {busy ? 'Checking…' : status?.hasKey ? 'Replace key' : 'Save key'}
        </button>
        {status?.hasKey && (
          <button className="btn" onClick={handleRemove} disabled={busy}>
            Remove
          </button>
        )}
      </div>

      <p className="signin-fine">
        Your key is encrypted before it is stored and is never shown again after saving.
        It is used only to score jobs and draft outreach for your account.
      </p>
    </div>
  )
}
