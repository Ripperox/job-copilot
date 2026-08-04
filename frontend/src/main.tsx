import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
// system.css AFTER index.css: the legacy sheet re-declares :root, so loading
// it first meant the v1 tokens (neon accent, square corners) silently won.
import './styles/system.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
