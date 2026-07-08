'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

const DATA_ITEMS = [
  {
    type: 'Perfil e identidad',
    reason: 'Nombre, email, país e idioma — para personalizar tu experiencia y cumplir requisitos legales.',
  },
  {
    type: 'Transacciones financieras',
    reason: 'Ingresos, gastos y categorías — el núcleo de tu análisis de soberanía financiera.',
  },
  {
    type: 'Perfil fiscal',
    reason: 'Tipo de empleo, ingresos brutos y beneficios — para calcular tu ratio de impacto fiscal.',
  },
  {
    type: 'Historial ICA',
    reason: 'Evolución de tu Índice de Certeza Algorítmica — para mostrarte tu progreso real.',
  },
  {
    type: 'Conversaciones con la IA',
    reason: 'Preguntas y respuestas con el CFO — para mejorar el contexto de tus análisis futuros.',
  },
  {
    type: 'Documentos subidos',
    reason: 'Facturas, nóminas y extractos — para automatizar el registro de transacciones.',
  },
]

export default function PrivacyPage() {
  const [userEmail, setUserEmail] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deletionDate, setDeletionDate] = useState<string | null>(null)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const router = useRouter()

  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(({ data }) => {
      setUserEmail(data.user?.email ?? null)
    })
  }, [])

  async function handleExport() {
    setExporting(true)
    setMessage(null)
    try {
      const res = await fetch('/api/gdpr/export', { method: 'POST' })
      if (!res.ok) throw new Error()
      const data = await res.json()
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `sovereign-cfo-datos-${new Date().toISOString().split('T')[0]}.json`
      a.click()
      URL.revokeObjectURL(url)
      setMessage({ type: 'success', text: 'Datos exportados correctamente.' })
    } catch {
      setMessage({ type: 'error', text: 'Error al exportar tus datos. Intenta de nuevo.' })
    } finally {
      setExporting(false)
    }
  }

  async function handleDeleteRequest() {
    const confirmed = window.confirm(
      '¿Seguro que quieres solicitar la eliminación de tu cuenta?\n\nTus datos se eliminarán en 30 días. Esta acción cerrará tu sesión.'
    )
    if (!confirmed) return

    setDeleting(true)
    setMessage(null)
    try {
      const res = await fetch('/api/gdpr/delete', { method: 'POST' })
      if (!res.ok) throw new Error()
      const { deletion_date } = await res.json()
      const formatted = new Date(deletion_date).toLocaleDateString('es-ES', {
        day: 'numeric', month: 'long', year: 'numeric',
      })
      setDeletionDate(formatted)
      setMessage({ type: 'success', text: `Solicitud registrada. Tu cuenta será eliminada el ${formatted}.` })
      const supabase = createClient()
      await supabase.auth.signOut()
      setTimeout(() => router.push('/login'), 3500)
    } catch {
      setMessage({ type: 'error', text: 'Error al procesar la solicitud. Intenta de nuevo.' })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#F9F9F9]">
      <div className="container mx-auto px-4 py-12 max-w-3xl">

        <div className="mb-10">
          <h1 className="text-3xl font-bold text-[#1A1A1A] mb-2">Transparencia y Privacidad</h1>
          <p className="text-gray-600">
            Tu privacidad es nuestra fortaleza. Aquí tienes todo lo que necesitas saber sobre tus datos.
          </p>
        </div>

        {/* Datos que recopilamos */}
        <section className="bg-white rounded-xl shadow-sm p-6 mb-6">
          <h2 className="text-xl font-semibold text-[#1A1A1A] mb-5">Datos que recopilamos</h2>
          <div className="space-y-4">
            {DATA_ITEMS.map((item) => (
              <div key={item.type} className="flex gap-3">
                <div className="w-2 h-2 rounded-full bg-[#D9B648] mt-2 flex-shrink-0" />
                <div>
                  <p className="font-medium text-[#1A1A1A]">{item.type}</p>
                  <p className="text-sm text-gray-600">{item.reason}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Tus derechos GDPR */}
        <section className="bg-white rounded-xl shadow-sm p-6 mb-6">
          <h2 className="text-xl font-semibold text-[#1A1A1A] mb-4">Tus derechos GDPR</h2>
          <ul className="space-y-3 text-sm text-gray-700">
            <li><span className="font-medium">Acceso:</span> Descarga todos tus datos en formato JSON en cualquier momento.</li>
            <li><span className="font-medium">Rectificación:</span> Edita tu perfil directamente desde la configuración de tu cuenta.</li>
            <li><span className="font-medium">Supresión:</span> Solicita la eliminación completa e irreversible de tu cuenta y datos.</li>
            <li><span className="font-medium">Portabilidad:</span> Tus datos se entregan en formato legible por máquina (JSON).</li>
            <li><span className="font-medium">Oposición:</span> Revoca tu consentimiento en cualquier momento contactando a privacidad@andgcore.com.</li>
          </ul>
        </section>

        {/* Retención */}
        <section className="bg-white rounded-xl shadow-sm p-6 mb-8">
          <h2 className="text-xl font-semibold text-[#1A1A1A] mb-3">Retención de datos</h2>
          <p className="text-sm text-gray-600">
            Tus datos se conservan mientras tu cuenta esté activa. Tras solicitar la eliminación,
            todos tus datos se eliminan permanentemente en un plazo máximo de{' '}
            <span className="font-semibold">30 días</span>, conforme al Artículo 17 del RGPD.
          </p>
        </section>

        {/* Acciones de usuario */}
        {userEmail && (
          <section className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="text-xl font-semibold text-[#1A1A1A] mb-1">Gestionar mis datos</h2>
            <p className="text-sm text-gray-500 mb-6">Sesión activa: {userEmail}</p>

            {message && (
              <div
                className={`mb-5 p-4 rounded-lg text-sm font-medium ${
                  message.type === 'success'
                    ? 'bg-green-50 text-green-800 border border-green-200'
                    : 'bg-red-50 text-red-800 border border-red-200'
                }`}
              >
                {message.text}
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-4">
              <button
                onClick={handleExport}
                disabled={exporting}
                className="flex-1 py-3 px-6 rounded-xl font-semibold text-white bg-[#D9B648] hover:bg-[#c9a438] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {exporting ? 'Exportando...' : 'Exportar mis datos'}
              </button>
              <button
                onClick={handleDeleteRequest}
                disabled={deleting || deletionDate !== null}
                className="flex-1 py-3 px-6 rounded-xl font-semibold text-white bg-red-600 hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {deleting
                  ? 'Procesando...'
                  : deletionDate
                    ? `Eliminación el ${deletionDate}`
                    : 'Solicitar eliminación de cuenta'}
              </button>
            </div>
          </section>
        )}

      </div>
    </div>
  )
}
