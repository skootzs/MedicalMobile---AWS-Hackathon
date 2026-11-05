import { createWorkspace } from './workspace.js'
window.chtWorkspace = createWorkspace()
await import('/app.js')
