// Placeholder rows shaped like the job cards that are about to replace them, so
// the first load reads as "your list is arriving" rather than "nothing here".
// Built on .u-skeleton from system.css; the stagger keeps the shimmer from
// pulsing as one solid block.
export default function DashSkeleton({ rows }: { rows: number }) {
  return (
    <div className="dsh-sk">
      <p className="dsh-sr" role="status">
        Loading your jobs…
      </p>
      {Array.from({ length: rows }, (_, i) => (
        <div className="dsh-sk-card" key={i} aria-hidden="true">
          <span
            className="u-skeleton dsh-sk-line is-title"
            style={{ animationDelay: `${i * 90}ms` }}
          />
          <span
            className="u-skeleton dsh-sk-line is-meta"
            style={{ animationDelay: `${i * 90 + 40}ms` }}
          />
          <span
            className="u-skeleton dsh-sk-block"
            style={{ animationDelay: `${i * 90 + 80}ms` }}
          />
          <div className="dsh-sk-row">
            <span
              className="u-skeleton dsh-sk-pill"
              style={{ animationDelay: `${i * 90 + 120}ms` }}
            />
            <span
              className="u-skeleton dsh-sk-pill is-wide"
              style={{ animationDelay: `${i * 90 + 150}ms` }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}
