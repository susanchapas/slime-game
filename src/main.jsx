import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import SlimeApp from './SlimeApp'

createRoot(document.getElementById('root')).render(<StrictMode><SlimeApp /></StrictMode>)
