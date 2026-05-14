'use client'

import { useState, useEffect, useRef } from 'react'

interface PowerLeak {
  id: string
  description: string
  amount: number
  category: string
}

interface PowerLeakBadgeProps {
  count: number
  totalAmount: number
  leaks?: PowerLeak[]
}

export default function PowerLeakBadge({ count, totalAmount, leaks = [] }: PowerLeakBadgeProps) {
  const [isOpen, setIsOpen] = useState(false)
  const hasLeaks = count > 0
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`px-6 py-3 rounded-lg font-semibold text-white transition-all ${
          hasLeaks 
            ? 'bg-[#E85C5C] hover:bg-[#E85C5C]/90' 
            : 'bg-[#4CAF7D] hover:bg-[#4CAF7D]/90'
        }`}
      >
        <div className="flex items-center gap-3">
          <span className="text-2xl">{hasLeaks ? '⚠️' : '✓'}</span>
          <div className="text-left">
            <div className="text-sm opacity-90">
              {hasLeaks ? 'Fugas Detectadas' : 'Sin Fugas'}
            </div>
            <div className="text-lg font-bold">
              {hasLeaks ? `${count} fuga${count > 1 ? 's' : ''} · ${totalAmount.toFixed(2)}€/mes` : 'Todo bajo control'}
            </div>
          </div>
        </div>
      </button>

      {isOpen && hasLeaks && leaks.length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-2 bg-white rounded-lg border-2 border-[#E85C5C] shadow-lg z-10 max-h-96 overflow-y-auto">
          <div className="p-4 border-b border-gray-200 bg-[#E85C5C]/10">
            <h3 className="font-bold text-[#1A1A1A]">Detalle de Fugas de Poder</h3>
            <p className="text-sm text-gray-600">Gastos que están drenando tu dominio financiero</p>
          </div>
          
          <div className="divide-y divide-gray-200">
            {leaks.map((leak) => (
              <div key={leak.id} className="p-4 hover:bg-gray-50 transition-colors">
                <div className="flex justify-between items-start mb-2">
                  <div className="flex-1">
                    <div className="font-semibold text-[#1A1A1A]">{leak.description}</div>
                    <div className="text-sm text-gray-500">{leak.category}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-bold text-[#E85C5C]">{leak.amount.toFixed(2)}€</div>
                    <div className="text-xs text-gray-500">al mes</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
          
          <div className="p-4 bg-[#F0EDE6] border-t border-gray-200">
            <div className="flex justify-between items-center">
              <span className="font-semibold text-[#1A1A1A]">Total mensual perdido:</span>
              <span className="text-xl font-bold text-[#E85C5C]">{totalAmount.toFixed(2)}€</span>
            </div>
            <p className="text-xs text-gray-600 mt-2">
              💡 Eliminar estas fugas podría ahorrarte {(totalAmount * 12).toFixed(2)}€ al año
            </p>
          </div>
        </div>
      )}

      {isOpen && !hasLeaks && (
        <div className="absolute top-full left-0 right-0 mt-2 bg-white rounded-lg border-2 border-[#4CAF7D] shadow-lg z-10 p-6">
          <div className="text-center">
            <div className="text-4xl mb-3">🎯</div>
            <h3 className="font-bold text-[#1A1A1A] mb-2">¡Excelente!</h3>
            <p className="text-sm text-gray-600">
              No hemos detectado fugas de poder en tus finanzas. Sigue así.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
