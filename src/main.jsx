import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './styles.css'
import { registerWorker } from './push.js'

registerWorker()

createRoot(document.getElementById('root')).render(<App />)
