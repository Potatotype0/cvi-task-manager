import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Relative paths so the build also works from a GitHub Pages sub-folder.
export default defineConfig({ base: './', plugins: [react()] })
