// Turning a thrown request error into something a person can act on.
//
// api.ts throws `Error("Request failed (500): {\"error\":…}")` — a status code
// and a raw JSON blob. Dumping that in a banner tells a job-hunter nothing about
// whether their data is safe or what to do next, so nothing in here ever leads
// with a status code. Every case answers three questions: what failed, what it
// means for me, and what do I do now. The raw text is kept, but folded away.

export type DashErrorContext = 'load' | 'fetch' | 'rescore'

export interface DashErrorInfo {
  /** Plain-language headline. Never a status code. */
  title: string
  /** What it means — including whether anything was lost. */
  body: string
  /** Optional next step when retrying alone will not fix it. */
  hint?: string
  retryLabel: string
  /** True when re-running the action is the wrong move and re-reading is right. */
  prefersReload?: boolean
  /** Shown only inside the folded technical detail. */
  code: number | null
  detail: string | null
}

const RETRY: Record<DashErrorContext, string> = {
  load: 'Reload jobs',
  fetch: 'Try fetching again',
  rescore: 'Try re-scoring again',
}

const FAILED: Record<DashErrorContext, string> = {
  load: 'Couldn’t load your jobs',
  fetch: 'The fetch didn’t finish',
  rescore: 'Re-scoring didn’t finish',
}

// What a server-side failure actually costs you, per action. Reassurance has to
// be specific to be worth anything.
const SERVER_BODY: Record<DashErrorContext, string> = {
  load: 'The server hit a problem while reading your list. Nothing was changed — this was only a read, and your jobs are still stored.',
  fetch:
    'The server broke partway through reading the job sources or scoring them. Anything already saved is untouched, and a retry usually gets through.',
  rescore:
    'Scoring stopped partway through. Jobs that were already re-scored kept their new score, the rest still have the old one, and nothing was deleted.',
}

// fetch() rejects with a TypeError when the request never left the browser or
// the host was unreachable. Message text differs per engine, so match loosely —
// but anchored, because the server's own 500 body says "Failed to fetch jobs"
// and that must not be mistaken for a dead connection.
function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) return true
  const m = err instanceof Error ? err.message.toLowerCase().trim() : ''
  return /^(failed to fetch|networkerror|load failed|network request failed)/.test(m)
}

function parseRequestError(message: string): {
  status: number | null
  server: string | null
  detail: string | null
} {
  const m = /^Request failed \((\d{3})\)(?::\s*)?([\s\S]*)$/.exec(message)
  if (!m) return { status: null, server: null, detail: null }

  const status = Number(m[1])
  const raw = (m[2] ?? '').trim()
  if (!raw) return { status, server: null, detail: null }

  // api.ts truncates the body at 200 chars, so the JSON may not parse.
  if (raw.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>
        return {
          status,
          server: typeof obj.error === 'string' ? obj.error : null,
          detail: typeof obj.detail === 'string' ? obj.detail : raw,
        }
      }
    } catch {
      // fall through — a truncated body is still useful as detail text
    }
  }
  return { status, server: null, detail: raw }
}

export function describeError(
  err: unknown,
  context: DashErrorContext,
): DashErrorInfo {
  const retryLabel = RETRY[context]
  const message = err instanceof Error ? err.message : String(err)
  const { status, server, detail } = parseRequestError(message)

  // A response we got is never a connection failure, whatever its body says.
  if (status === null && isNetworkError(err)) {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false
    return offline
      ? {
          title: 'You’re offline',
          body: 'Your browser has no connection, so the request never left this page. Nothing here has been lost — reconnect and pick up where you left off.',
          retryLabel,
          code: null,
          detail: message,
        }
      : {
          title: 'Can’t reach the server',
          body: 'The request never got through to the Shortlist backend. It may be restarting, waking up from sleep, or blocked by your network.',
          hint: 'Give it a few seconds and try again. If it keeps failing, check that the backend is actually running.',
          retryLabel,
          code: null,
          detail: message,
        }
  }

  if (status === null) {
    return {
      title: FAILED[context],
      body: 'Something went wrong before the server could answer. This is usually momentary, and trying again clears it.',
      retryLabel,
      code: null,
      detail: message,
    }
  }

  if (status === 409) {
    return {
      title: 'A fetch is already running',
      body: 'Only one fetch runs at a time and another one has already started — usually a second tab, or one you kicked off a moment ago.',
      hint: 'Give it a minute to land, then reload the list to see what it brought in.',
      retryLabel: 'Reload jobs',
      prefersReload: true,
      code: status,
      detail,
    }
  }

  if (status === 429) {
    return {
      title: 'Too many requests for now',
      body: 'The scoring provider is rate-limiting us. Nothing is broken and nothing was lost — it just needs a minute or two of quiet.',
      hint: 'Adding your own API key on the Profile tab gives you a quota of your own instead of sharing this one.',
      retryLabel,
      code: status,
      detail,
    }
  }

  if (status === 400 && /profile/i.test(server ?? '')) {
    return {
      title: 'Add your profile first',
      body: 'Every posting is scored against your resume and preferences, and there is nothing to compare against yet.',
      hint: 'Open the Profile tab, paste your resume, set your roles and salary floor, save — then come back and run this again.',
      retryLabel,
      code: status,
      detail,
    }
  }

  if (status === 503) {
    return {
      title: 'The server isn’t ready',
      body:
        server ??
        'Part of the backend is not configured or has not finished starting up, so it turned this request down.',
      hint: 'This one is on the server, not on you. Try again shortly.',
      retryLabel,
      code: status,
      detail,
    }
  }

  if (status >= 500) {
    return {
      title: FAILED[context],
      body: SERVER_BODY[context],
      retryLabel,
      code: status,
      detail,
    }
  }

  if (status === 404) {
    return {
      title: 'That isn’t there any more',
      body: 'The server couldn’t find what this page asked for. It may have been removed since the page was loaded.',
      hint: 'Reloading the list should bring you back in sync.',
      retryLabel: 'Reload jobs',
      prefersReload: true,
      code: status,
      detail,
    }
  }

  // Remaining 4xx: the server usually says something human — use it, and keep
  // a generic explanation underneath so the message is never a bare fragment.
  return {
    title: FAILED[context],
    body: server
      ? `${server} Nothing on this page has been changed.`
      : 'The server turned the request down. Nothing on this page has been changed.',
    retryLabel,
    code: status,
    detail,
  }
}

export default function DashError({
  info,
  onRetry,
  onDismiss,
}: {
  info: DashErrorInfo
  onRetry?: () => void
  onDismiss?: () => void
}) {
  const hasDetail = info.detail !== null || info.code !== null
  const detailText = [
    info.code === null ? null : `HTTP ${info.code}`,
    info.detail?.slice(0, 300),
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="dsh-err u-rise" role="alert">
      <span className="dsh-err-mark" aria-hidden="true">
        !
      </span>
      <div className="dsh-err-txt">
        <p className="dsh-err-t">{info.title}</p>
        <p className="dsh-err-b">{info.body}</p>
        {info.hint && <p className="dsh-err-h">{info.hint}</p>}

        <div className="dsh-err-acts">
          {onRetry && (
            <button type="button" className="dsh-btn dsh-btn-warn" onClick={onRetry}>
              {info.retryLabel}
            </button>
          )}
          {onDismiss && (
            <button type="button" className="dsh-btn dsh-btn-quiet" onClick={onDismiss}>
              Dismiss
            </button>
          )}
          {hasDetail && (
            <details className="dsh-err-more">
              <summary>Technical detail</summary>
              <p className="dsh-err-raw">{detailText}</p>
            </details>
          )}
        </div>
      </div>
    </div>
  )
}
