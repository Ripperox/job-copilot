import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MotionConfig } from 'motion/react'
import './index.css'
// system.css AFTER index.css. index.css used to be the whole v1 stylesheet and
// re-declared :root, so loading it first meant the v1 tokens (neon accent,
// square corners) silently won. It is a base sheet now and declares no tokens,
// but the order is still the right one: base first, design system second.
import './styles/system.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* reducedMotion="user" makes every motion component obey the OS setting
        without each one having to remember to check. The CSS side is handled
        by the prefers-reduced-motion block in system.css; this is the same
        promise for the JS-driven animations. */}
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </StrictMode>,
)
