'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import IcaCircle from '@/components/dashboard/IcaCircle'
import MetricCard from '@/components/dashboard/MetricCard'
import PowerLeakBadge from '@/components/dashboard/PowerLeakBadge'

interface DashboardData {
  score: number
  metrics: {
    monthlyIncome: number
    monthlyExpenses: number
    savings: number
    leaksDetected: number
    leaksAmount: number
  }
  powerLeaks: {
    count: number
    totalAmount: number
    leaks: Array<{
      id: string
      description: string
      amount: number
      category: string
    }>
  }
}

export default function DashboardPage() {
  const router = useRouter()
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchDashboardData = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const response = await fetch('/api/ica/score')
      
      if (response.status === 401) {
        router.push('/login')
        return
      }

      if (!response.ok) {
        throw new Error('Error al cargar datos del dashboard')
      }

      const dashboardData = await response.json()
      setData(dashboardData)
    } catch (err) {
      console.error('Error fetching dashboard data:', err)
      setError(err instanceof Error ? err.message : 'Error desconocido')
    } finally {
      setLoading(false)
    }
  }, [router])

  useEffect(() => {
    fetchDashboardData()
  }, [fetchDashboardData])

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F9F9F9]">
        <div className="container mx-auto px-4 py-8">
          <div className="animate-pulse space-y-8">
            <div className="flex justify-center">
              <div className="w-64 h-64 bg-[#F0EDE6] rounded-full"></div>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="h-32 bg-white rounded-lg border-2 border-[#E4DFD5]"></div>
              ))}
            </div>
            
            <div className="h-48 bg-white rounded-lg border-2 border-[#E4DFD5]"></div>
          </div>
        </div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-[#F9F9F9] flex items-center justify-center">
        <div className="bg-white rounded-lg shadow-lg p-8 max-w-md">
          <div className="text-center">
            <div className="text-6xl mb-4">⚠️</div>
            <h2 className="text-2xl font-bold text-[#1A1A1A] mb-3">Error</h2>
            <p className="text-gray-600 mb-6">{error || 'Error al cargar el dashboard'}</p>
            <button
              onClick={fetchDashboardData}
              className="px-6 py-3 bg-[#D9B648] text-[#1A1A1A] rounded-lg font-medium hover:bg-[#D9B648]/90 transition-colors"
            >
              Reintentar
            </button>
          </div>
        </div>
      </div>
    )
  }

  const savingsPercentage = data.metrics.monthlyIncome > 0 
    ? ((data.metrics.savings / data.metrics.monthlyIncome) * 100).toFixed(1)
    : '0'

  return (
    <div className="min-h-screen bg-[#F9F9F9]">
      <div className="container mx-auto px-4 py-8 max-w-7xl">
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-[#1A1A1A] mb-2">
            Tu Dashboard de Dominio Financiero
          </h1>
          <p className="text-gray-600">
            Visión completa de tu situación financiera
          </p>
        </div>

        <div className="bg-white rounded-lg shadow-lg p-8 mb-8">
          <IcaCircle score={data.score} size={280} animated={true} />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          <MetricCard
            label="Ingresos del Mes"
            value={`${data.metrics.monthlyIncome.toLocaleString('es-ES')}€`}
            trend="up"
            icon="💰"
            color="#4CAF7D"
          />
          
          <MetricCard
            label="Gastos del Mes"
            value={`${data.metrics.monthlyExpenses.toLocaleString('es-ES')}€`}
            trend="down"
            icon="📊"
            color="#E8A93C"
          />
          
          <MetricCard
            label="Fugas Detectadas"
            value={data.metrics.leaksDetected}
            trend={data.metrics.leaksDetected > 0 ? 'down' : 'neutral'}
            icon="⚠️"
            color="#E85C5C"
          />
          
          <MetricCard
            label="Ahorro del Mes"
            value={`${data.metrics.savings.toLocaleString('es-ES')}€`}
            trend="up"
            icon="🎯"
            color="#D9B648"
          />
        </div>

        <div className="mb-8">
          <PowerLeakBadge
            count={data.powerLeaks.count}
            totalAmount={data.powerLeaks.totalAmount}
            leaks={data.powerLeaks.leaks}
          />
        </div>

        <div className="bg-white rounded-lg shadow-lg p-8">
          <h2 className="text-2xl font-bold text-[#1A1A1A] mb-6">
            Tu Camino al Dominio
          </h2>
          
          <div className="space-y-4">
            <div className="flex items-start gap-4 p-4 bg-[#F0EDE6] rounded-lg">
              <div className="text-3xl">🎯</div>
              <div className="flex-1">
                <h3 className="font-semibold text-[#1A1A1A] mb-1">
                  Próximo Hito: Reserva de Emergencia
                </h3>
                <p className="text-sm text-gray-600 mb-3">
                  Construye un colchón de 3 meses de gastos para alcanzar seguridad financiera
                </p>
                <div className="w-full bg-white rounded-full h-3 overflow-hidden">
                  <div 
                    className="bg-[#D9B648] h-full transition-all duration-500"
                    style={{ width: '35%' }}
                  />
                </div>
                <div className="flex justify-between mt-2 text-xs text-gray-600">
                  <span>35% completado</span>
                  <span>Meta: {(data.metrics.monthlyExpenses * 3).toLocaleString('es-ES')}€</span>
                </div>
              </div>
            </div>

            <div className="flex items-start gap-4 p-4 bg-[#F0EDE6] rounded-lg opacity-60">
              <div className="text-3xl">🔒</div>
              <div className="flex-1">
                <h3 className="font-semibold text-[#1A1A1A] mb-1">
                  Eliminar Fugas de Poder
                </h3>
                <p className="text-sm text-gray-600">
                  Identifica y elimina gastos innecesarios que drenan tu poder financiero
                </p>
                <div className="mt-2 text-xs text-gray-500">
                  🔓 Se desbloquea al completar Reserva de Emergencia
                </div>
              </div>
            </div>

            <div className="flex items-start gap-4 p-4 bg-[#F0EDE6] rounded-lg opacity-60">
              <div className="text-3xl">📈</div>
              <div className="flex-1">
                <h3 className="font-semibold text-[#1A1A1A] mb-1">
                  Inversión Estratégica
                </h3>
                <p className="text-sm text-gray-600">
                  Haz que tu dinero trabaje para ti con inversiones inteligentes
                </p>
                <div className="mt-2 text-xs text-gray-500">
                  🔓 Se desbloquea al eliminar todas las fugas
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-8 bg-[#F7EBA5] rounded-lg p-6">
          <div className="flex items-start gap-4">
            <div className="text-3xl">💡</div>
            <div>
              <h3 className="font-semibold text-[#1A1A1A] mb-2">
                Consejo del Día
              </h3>
              <p className="text-sm text-gray-700">
                Estás ahorrando el {savingsPercentage}% de tus ingresos. 
                {parseFloat(savingsPercentage) < 20 
                  ? ' Intenta alcanzar al menos el 20% para acelerar tu camino al dominio financiero.'
                  : ' ¡Excelente! Mantén este ritmo y alcanzarás tus metas más rápido.'}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
