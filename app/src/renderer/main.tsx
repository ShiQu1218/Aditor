import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/tokens.css'
import './styles/base.css'
import './styles/shell.css'
import './styles/libraryTokens.css'
import './styles/library.css'
import './styles/settings.css'
import App from './App'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
