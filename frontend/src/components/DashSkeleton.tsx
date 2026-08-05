// Placeholder rows shaped like the job rows that are about to replace them, so
// the first load reads as "your list is arriving" rather than "nothing here".
//
// Shape matters more than shimmer: these sit on the same four-column grid as a
// real row (score, title block, verdict, tail), so nothing jumps when the data
// lands. Built on .u-skeleton from system.css; the stagger keeps the shimmer
// from pulsing as one solid block.
export default function DashSkeleton({ rows }: { rows: number }) {
  return (
    <div className="dsh-sk">
      <p className="dsh-sr" role="status">
        Loading your jobs…
      </p>
      {Array.from({ length: rows }, (_, i) => {
        const d = i * 70
        return (
          <div className="dsh-sk-row" key={i} aria-hidden="true">
            <span className="dsh-sk-score">
              <span
                className="u-skeleton dsh-sk-line is-num"
                style={{ animationDelay: `${d}ms` }}
              />
              <span
                className="u-skeleton dsh-sk-line is-meter"
                style={{ animationDelay: `${d + 30}ms` }}
              />
            </span>

            <span className="dsh-sk-main">
              <span
                className="u-skeleton dsh-sk-line is-title"
                style={{ animationDelay: `${d + 40}ms` }}
              />
              <span
                className="u-skeleton dsh-sk-line is-sub"
                style={{ animationDelay: `${d + 70}ms` }}
              />
            </span>

            <span className="dsh-sk-main dsh-sk-verd">
              <span
                className="u-skeleton dsh-sk-line is-verd"
                style={{ animationDelay: `${d + 90}ms` }}
              />
              <span
                className="u-skeleton dsh-sk-line is-verd2"
                style={{ animationDelay: `${d + 110}ms` }}
              />
            </span>

            <span className="dsh-sk-tail">
              <span
                className="u-skeleton dsh-sk-line is-tail"
                style={{ animationDelay: `${d + 130}ms` }}
              />
            </span>
          </div>
        )
      })}
    </div>
  )
}
