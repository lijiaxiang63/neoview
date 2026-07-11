import '../styles/app.css'
import '../styles/settings.css'

import { createRoot } from 'react-dom/client'
import { StrictMode } from 'react'
import { SettingsApp } from './SettingsApp'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SettingsApp />
  </StrictMode>
)
