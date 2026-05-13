'use client'

import { useState, useCallback } from 'react'

interface PactoModalProps {
  onAccept: () => void
  onReject: () => void
}

export default function PactoModal({ onAccept, onReject }: PactoModalProps) {
  const [accepted, setAccepted] = useState(false)

  const handleCheckboxChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setAccepted(e.target.checked)
  }, [])

  return (
    <div className="space-y-6">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-bold text-[#1A1A1A] mb-3">
          Pacto de Datos
        </h2>
        <p className="text-gray-600">
          Tu privacidad es nuestra prioridad
        </p>
      </div>

      <div className="bg-white border-2 border-[#E4DFD5] rounded-lg p-6 space-y-4 max-h-96 overflow-y-auto">
        <section>
          <h3 className="font-semibold text-[#1A1A1A] mb-2">
            🔒 Compromiso de Privacidad
          </h3>
          <p className="text-sm text-gray-700">
            Tus datos financieros están encriptados end-to-end. Nunca compartiremos, 
            venderemos ni utilizaremos tu información para publicidad.
          </p>
        </section>

        <section>
          <h3 className="font-semibold text-[#1A1A1A] mb-2">
            📊 Uso de Datos
          </h3>
          <ul className="text-sm text-gray-700 space-y-1 list-disc list-inside">
            <li>Análisis de tu situación financiera personal</li>
            <li>Generación de recomendaciones personalizadas</li>
            <li>Proyecciones y simulaciones de escenarios</li>
            <li>Mejora continua de nuestros algoritmos (datos anonimizados)</li>
          </ul>
        </section>

        <section>
          <h3 className="font-semibold text-[#1A1A1A] mb-2">
            🛡️ Tus Derechos
          </h3>
          <ul className="text-sm text-gray-700 space-y-1 list-disc list-inside">
            <li>Acceso completo a todos tus datos en cualquier momento</li>
            <li>Exportación de datos en formato estándar</li>
            <li>Eliminación permanente de tu cuenta y datos</li>
            <li>Modificación de preferencias de privacidad</li>
          </ul>
        </section>

        <section>
          <h3 className="font-semibold text-[#1A1A1A] mb-2">
            🌍 GDPR & Cumplimiento
          </h3>
          <p className="text-sm text-gray-700">
            Cumplimos con GDPR, LOPD y regulaciones internacionales de protección de datos. 
            Tus datos se almacenan en servidores europeos con certificación ISO 27001.
          </p>
        </section>

        <section className="bg-[#F7EBA5] p-4 rounded-lg">
          <h3 className="font-semibold text-[#1A1A1A] mb-2">
            ✨ Nuestra Promesa
          </h3>
          <p className="text-sm text-gray-700">
            Sovereign CFO existe para empoderarte financieramente. Tus datos son tuyos, 
            siempre. Trabajamos para ti, no para anunciantes.
          </p>
        </section>
      </div>

      <div className="flex items-start space-x-3 bg-[#F0EDE6] p-4 rounded-lg">
        <input
          type="checkbox"
          id="accept-pacto"
          checked={accepted}
          onChange={handleCheckboxChange}
          className="mt-1 w-5 h-5 text-[#D9B648] border-gray-300 rounded focus:ring-[#D9B648]"
        />
        <label htmlFor="accept-pacto" className="text-sm text-gray-700 cursor-pointer">
          He leído y acepto el Pacto de Datos. Entiendo cómo se utilizarán mis datos 
          y conozco mis derechos de privacidad.
        </label>
      </div>

      <div className="flex gap-4">
        <button
          onClick={onReject}
          className="flex-1 px-6 py-3 border-2 border-[#E4DFD5] text-[#1A1A1A] rounded-lg font-medium hover:bg-[#F0EDE6] transition-colors"
        >
          Rechazar
        </button>
        <button
          onClick={onAccept}
          disabled={!accepted}
          className="flex-1 px-6 py-3 bg-[#D9B648] text-[#1A1A1A] rounded-lg font-medium hover:bg-[#D9B648]/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Aceptar y Continuar
        </button>
      </div>
    </div>
  )
}
