'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Sidebar from '@/components/layout/Sidebar'
import ConstruccionPlaceholder from '@/components/ConstruccionPlaceholder'
import { createClient } from '@/lib/supabase/client'

export default function SettingsPage() {
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
        title="Configuración"
        description="Aquí gestionarás tu perfil, idioma y moneda, tus preferencias de notificación del Consigliere, tu plan y facturación, y el control total de tus datos: exportarlos o eliminarlos cuando quieras."
      />
    </div>
  )
}
