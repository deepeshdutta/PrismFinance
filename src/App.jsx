import React from 'react'
import Dashboard from './components/Dashboard'

function App() {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm sticky top-0 z-10">
        <div className="max-w-md mx-auto px-4 py-4">
          <h1 className="text-xl font-bold text-gray-900">PrismFinance</h1>
          <p className="text-sm text-gray-500">Personal Wealth Platform</p>
        </div>
      </header>
      <main className="max-w-md mx-auto px-4 py-6">
        <Dashboard />
      </main>
    </div>
  )
}

export default App
