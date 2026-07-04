import React from 'react'
import ReactDOM from 'react-dom/client'
import SuperAdmin from './components/SuperAdmin'
import ErrorBoundary from './ErrorBoundary'

// Entry for the standalone superadmin/ops console (ops.html). Completely
// separate page + login from the customer admin app.
ReactDOM.createRoot(document.getElementById('ops-root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <SuperAdmin />
    </ErrorBoundary>
  </React.StrictMode>
)
