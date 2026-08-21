'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Sidebar from '@/components/layout/Sidebar'
import ConstruccionPlaceholder from '@/components/ConstruccionPlaceholder'
import { createClient } from '@/lib/supabase/client'

export default function ReportsPage() {
  const router = useRouter()
  const [isDark, setIsDark] = useState(false)

  useEffect(() => {
    const saved = localStorage.getItem('darkMode')
    if (saved === 'true') setIsDark(true)
  }, [])

  const toggleDark = useCallback(() => {
    setIsDark(prev => {
      localStorage.setItem('darkMode', (!prev).toString())
      return !prev
    })
  }, [])

  const handleLogout = useCallback(async () => {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
  }, [router])

  return (
    <div style={{ display: 'flex', flexDirection: 'row', minHeight: '100vh' }}>
      <Sidebar isDark={isDark} onToggleDark={toggleDark} onLogout={handleLogout} />
      <ConstruccionPlaceholder
        isDark={isDark}
        title="Reportes"
        description="Reportes descargables del estado de cada meta, del detalle de tus ingresos y gastos, y de tu información contable por si quieres trabajarla en un sistema dedicado."
      />
    </div>
  )
}
