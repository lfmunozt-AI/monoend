'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

const NAV_ITEMS = [
  { label: 'Dashboard', href: '/dashboard', icon: '📊' },
  { label: 'Transacciones', href: '/transactions', icon: '💳' },
  { label: 'Chat CFO', href: '/chat', icon: '💬' },
  { label: 'Proyecciones', href: '/projections', icon: '📈' },
  { label: 'Fugas', href: '/leaks', icon: '⚠️' },
  { label: 'Reportes', href: '/reports', icon: '📄' }
]

export default function Sidebar() {
  const pathname = usePathname()
  const [isDarkMode, setIsDarkMode] = useState(false)

  const toggleTheme = () => {
    setIsDarkMode(!isDarkMode)
  }

  return (
    <aside className="w-64 bg-[#1A1A1A] text-white flex flex-col h-screen fixed left-0 top-0 z-40">
      <div className="p-6 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-gradient-to-br from-[#D9B648] to-[#C9A84C] rounded-lg flex items-center justify-center">
            <span className="text-white font-bold text-sm">A</span>
          </div>
          <span className="text-[#D9B648] font-bold text-lg">andgcore</span>
        </div>
      </div>

      <nav className="flex-1 py-6 overflow-y-auto">
        {NAV_ITEMS.map((item) => {
          const isActive = pathname === item.href
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`
                flex items-center gap-3 px-6 py-3 transition-colors
                ${isActive 
                  ? 'bg-[#D9B648]/10 text-[#D9B648] border-l-4 border-[#D9B648]' 
                  : 'text-gray-400 hover:text-white hover:bg-white/5'
                }
              `}
            >
              <span className="text-xl">{item.icon}</span>
              <span className="font-medium">{item.label}</span>
            </Link>
          )
        })}
      </nav>

      <div className="border-t border-gray-800">
        <button
          onClick={toggleTheme}
          className="w-full px-6 py-4 flex items-center gap-3 text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
        >
          <span className="text-xl">{isDarkMode ? '☀️' : '🌙'}</span>
          <span className="font-medium">
            {isDarkMode ? 'Light Mode' : 'Dark Mode'}
          </span>
        </button>

        <div className="px-6 py-4 bg-gradient-to-r from-[#D9B648]/10 to-transparent">
          <div className="text-xs text-gray-500 mb-1">Plan Actual</div>
          <div className="flex items-center justify-between">
            <span className="text-[#D9B648] font-semibold">Soberano</span>
            <button className="text-xs text-white bg-[#D9B648] px-3 py-1 rounded-full hover:bg-[#D9B648]/90 transition-colors">
              Upgrade a Élite
            </button>
          </div>
        </div>
      </div>
    </aside>
  )
}
