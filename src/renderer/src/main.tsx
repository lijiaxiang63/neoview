import './styles/app.css'

import { createRoot } from 'react-dom/client'
import RuntimeRoot from './runtime/RuntimeRoot'

createRoot(document.getElementById('root')!).render(<RuntimeRoot />)
