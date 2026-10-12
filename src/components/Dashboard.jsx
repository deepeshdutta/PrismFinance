import React from 'react'
import { PieChart, Pie, Cell, LineChart, Line, XAxis, YAxis, ResponsiveContainer } from 'recharts'

const allocationData = [
  { name: 'Stocks', value: 45 },
  { name: 'Bonds', value: 25 },
  { name: 'Cash', value: 15 },
  { name: 'Real Estate', value: 15 },
]

const COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6']

const netWorthData = [
  { month: 'Jan', value: 120000 },
  { month: 'Feb', value: 125000 },
  { month: 'Mar', value: 128000 },
  { month: 'Apr', value: 132000 },
  { month: 'May', value: 135000 },
]

export default function Dashboard() {
  return (
    <div className="space-y-6">
      {/* Net Worth Card */}
      <div className="bg-white rounded-2xl shadow-sm p-5">
        <p className="text-sm text-gray-500">Net Worth</p>
        <p className="text-3xl font-bold text-gray-900">$135,420</p>
        <p className="text-sm text-green-600 mt-1">+2.4% this month</p>
      </div>

      {/* Allocation Chart */}
      <div className="bg-white rounded-2xl shadow-sm p-5">
        <h2 className="text-lg font-semibold mb-4">Asset Allocation</h2>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={allocationData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70}>
                {allocationData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="flex flex-wrap gap-2 mt-2 text-xs">
          {allocationData.map((item, i) => (
            <span key={item.name} className="flex items-center">
              <span className="w-2 h-2 rounded-full mr-1" style={{backgroundColor: COLORS[i]}}></span>
              {item.name} {item.value}%
            </span>
          ))}
        </div>
      </div>

      {/* Trend Chart */}
      <div className="bg-white rounded-2xl shadow-sm p-5">
        <h2 className="text-lg font-semibold mb-4">Net Worth Trend</h2>
        <div className="h-40">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={netWorthData}>
              <XAxis dataKey="month" fontSize={12} />
              <YAxis hide />
              <Line type="monotone" dataKey="value" stroke="#3B82F6" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <p className="text-center text-xs text-gray-400">MVP starter • Multi-user ready • Supabase + Cloudflare next</p>
    </div>
  )
}
