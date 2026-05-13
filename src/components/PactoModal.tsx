'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

interface PactoModalProps {
  onAccept: () => void
}

export default function PactoModal({ onAccept }: PactoModalProps) {
  const [checked, setChecked] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  async function handleAccept() {
    if (!checked || loading) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/gdpr/consent', { method: 'POST' })
      if (!res.ok) throw new Error()
      onAccept()
    } catch {
      setError('Error al registrar el consentimiento. Intenta de nuevo.')
      setLoading(false)
    }
  }

  async function handleReject() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full mx-4 p-8">

        <div className="mb-6">
          <div className="w-12 h-12 bg-[#D9B648]/10 rounded-full flex items-center justify-center mb-4">
            <svg className="w-6 h-6 text-[#D9B648]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
              />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-[#1A1A1A] mb-3">El Pacto de Datos</h2>
          <p className="text-gray-700 leading-relaxed">
            Para proteger tu futuro al 100%, andgcore requiere visibilidad total.{' '}
            <span className="font-semibold text-[#1A1A1A]">Tu privacidad es nuestra fortaleza.</span>
          </p>
        </div>

        <div className="bg-gray-50 rounded-xl p-4 mb-6 text-sm text-gray-600 space-y-2">
          <p className="font-medium text-[#1A1A1A]">Al aceptar, autorizas a andgcore a:</p>
          <ul className="space-y-1 list-disc list-inside">
            <li>Analizar tus ingresos y gastos para protegerte</li>
            <li>Generar consejos financieros personalizados</li>
            <li>Almacenar tus datos con cifrado de extremo a extremo</li>
          </ul>
          <p className="text-xs text-gray-500 pt-1">
            Tus datos nunca se venden ni comparten con terceros. Puedes solicitar su eliminación en cualquier momento.
          </p>
        </div>

        <label className="flex items-start gap-3 cursor-pointer mb-6">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            className="mt-0.5 w-5 h-5 rounded border-gray-300 accent-[#D9B648] cursor-pointer flex-shrink-0"
          />
          <span className="text-sm text-gray-700">
            He leído y acepto el{' '}
            <a href="/privacy" target="_blank" className="text-[#D9B648] underline hover:text-[#c9a438]">
              Pacto de Datos y Política de Privacidad
            </a>
          </span>
        </label>

        {error && <p className="text-red-600 text-sm mb-4">{error}</p>}

        <div className="flex flex-col gap-3">
          <button
            onClick={handleAccept}
            disabled={!checked || loading}
            className="w-full py-3 px-6 rounded-xl font-semibold text-white bg-[#D9B648] hover:bg-[#c9a438] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loading ? 'Registrando...' : 'Acepto el Pacto'}
          </button>
          <button
            onClick={handleReject}
            className="w-full py-2 px-6 rounded-xl text-sm text-gray-500 hover:text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Rechazar y salir
          </button>
        </div>

      </div>
    </div>
  )
}
