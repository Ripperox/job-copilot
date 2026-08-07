// The mark. One of them.
//
// There were three: a lightning bolt in the browser tab, a pennant in the app
// shell, and three bars on the landing page. Nothing tied them together, so the
// product had no face — the thing you look for in a row of tabs was unrelated
// to the thing at the top of the page you landed on.
//
// This is the one that was actually saying something: a list, ranked, top item
// picked out. That is the entire product in three rectangles. The favicon in
// public/favicon.svg draws the same geometry, so the tab and the header match.
//
// Inherits currentColor, so the shell can tint it and the landing page can
// leave it plain without a second copy of the file.
export default function BrandMark({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1" y="2" width="14" height="3" rx="1.5" fill="currentColor" />
      <rect x="1" y="6.5" width="10" height="3" rx="1.5" fill="currentColor" opacity=".55" />
      <rect x="1" y="11" width="6" height="3" rx="1.5" fill="currentColor" opacity=".3" />
    </svg>
  )
}
