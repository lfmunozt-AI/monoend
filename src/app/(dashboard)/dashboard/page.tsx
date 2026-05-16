'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import IcaCircle from '@/components/dashboard/IcaCircle'
import MetricCard from '@/components/dashboard/MetricCard'
import { createClient } from '@/lib/supabase/client'

interface DashboardData {
  score: number
  metrics: {
    monthlyIncome: number
    monthlyExpenses: number
    savings: number
    leaksDetected: number
    leaksAmount: number
  }
}

function getSpeechMessage(name: string): string {
  const hour = new Date().getHours()
  if (hour >= 6 && hour < 12) {
    return `Buenos días, ${name}. Revisemos tu plan del día.`
  } else if (hour >= 12 && hour < 18) {
    return `¿Cómo van tus números de hoy, ${name}?`
  } else {
    return `Cierre del día. ¿Registramos las transacciones?`
  }
}

export default function DashboardPage() {
  const router = useRouter()
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [userName, setUserName] = useState('Tú')
  const [fabOpen, setFabOpen] = useState(false)
  const [bubbleVisible, setBubbleVisible] = useState(false)

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)

      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const raw =
          (user.user_metadata?.full_name as string | undefined) ||
          (user.user_metadata?.name as string | undefined) ||
          user.email?.split('@')[0] ||
          'Tú'
        setUserName(raw.split(' ')[0])
      }

      const response = await fetch('/api/ica/score')
      if (response.status === 401) {
        router.push('/login')
        return
      }
      if (!response.ok) throw new Error('Error al cargar datos del dashboard')
      setData(await response.json())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido')
    } finally {
      setLoading(false)
    }
  }, [router])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  useEffect(() => {
    if (!loading && data) {
      const t = setTimeout(() => setBubbleVisible(true), 400)
      return () => clearTimeout(t)
    }
  }, [loading, data])

  if (loading) return <LoadingSkeleton />
  if (error || !data) return <ErrorState error={error} onRetry={fetchData} />

  const speech = getSpeechMessage(userName)

  return (
    <>
      <style>{`
        @keyframes breathing {
          0%, 100% { transform: scale(1); }
          50%       { transform: scale(1.008); }
        }
        @keyframes bubbleFadeIn {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes fabPulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(201,168,76,0.4); }
          50%       { box-shadow: 0 0 0 8px rgba(201,168,76,0); }
        }
        @keyframes panelSlideUp {
          from { transform: translateY(100%); opacity: 0; }
          to   { transform: translateY(0);    opacity: 1; }
        }
        .consigliere-img {
          animation: breathing 4s ease-in-out infinite;
          transition: filter 0.3s ease;
        }
        .consigliere-img:hover { filter: brightness(1.05); }
        .speech-bubble {
          animation: bubbleFadeIn 0.6s ease forwards;
        }
        .fab-btn  { animation: fabPulse 3s ease-in-out infinite; }
        .fab-panel { animation: panelSlideUp 0.35s ease forwards; }
      `}</style>

      <div style={{ background: '#F4F1EA', minHeight: '100vh' }}>

        {/* ── DESKTOP (md+) ── */}
        <div className="hidden md:grid md:grid-cols-2 min-h-screen max-w-7xl mx-auto px-6 py-8" style={{ columnGap: 0 }}>

          {/* Left column */}
          <div className="flex flex-col gap-6 pr-10">
            <div>
              <h1 className="text-3xl font-bold mb-1" style={{ color: '#1A1A1A' }}>
                Tu Dominio Financiero
              </h1>
              <p className="text-sm" style={{ color: 'rgba(26,26,26,0.45)' }}>
                {new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })}
              </p>
            </div>

            <div className="flex justify-center py-2">
              <IcaCircle score={data.score} size={260} animated />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <MetricCard label="Ingresos del Mes" value={`${data.metrics.monthlyIncome.toLocaleString('es-ES')}€`} trend="up"   icon="💰" color="#4CAF7D" />
              <MetricCard label="Gastos del Mes"   value={`${data.metrics.monthlyExpenses.toLocaleString('es-ES')}€`} trend="down" icon="📊" color="#E8A93C" />
              <MetricCard label="Fugas Detectadas" value={data.metrics.leaksDetected} trend={data.metrics.leaksDetected > 0 ? 'down' : 'neutral'} icon="⚠️" color="#E85C5C" />
              <MetricCard label="Ahorro del Mes"   value={`${data.metrics.savings.toLocaleString('es-ES')}€`} trend="up" icon="🎯" color="#C9A84C" />
            </div>
          </div>

          {/* Right column — Consigliere floating */}
          <div className="relative flex flex-col items-start pt-4">

            {/* Speech bubble */}
            {bubbleVisible && (
              <div
                className="speech-bubble"
                style={{
                  background: 'white',
                  border: '0.5px solid rgba(26,26,26,0.1)',
                  borderRadius: '12px 12px 12px 0',
                  padding: '14px 18px',
                  maxWidth: '300px',
                  boxShadow: '0 4px 20px rgba(26,26,26,0.08)',
                  marginLeft: '8px',
                  marginBottom: '14px',
                }}
              >
                <p style={{ fontSize: '14px', fontWeight: 500, color: '#1A1A1A', margin: 0 }}>
                  {speech}
                </p>
              </div>
            )}

            {/* Quick actions */}
            <div style={{ display: 'flex', gap: '8px', marginLeft: '8px', marginBottom: '20px' }}>
              <QuickAction label="Ver ICA"       primary />
              <QuickAction label="Registrar gasto" />
              <QuickAction label="Analizar"       />
            </div>

            {/* Floating character */}
            <div className="flex-1 flex items-end justify-center w-full">
              <img
                src="/consigliere.png"
                alt="The Consigliere"
                className="consigliere-img"
                style={{ maxHeight: '62vh', maxWidth: '100%', objectFit: 'contain', objectPosition: 'bottom' }}
              />
            </div>

            {/* Chat input */}
            <div style={{ width: '100%', maxWidth: '360px', marginTop: '16px', alignSelf: 'center' }}>
              <ChatInput />
            </div>
          </div>
        </div>

        {/* ── MOBILE ── */}
        <div className="md:hidden px-4 py-6 pb-28">
          <h1 className="text-2xl font-bold mb-5" style={{ color: '#1A1A1A' }}>
            Tu Dominio
          </h1>

          <div className="flex justify-center mb-5">
            <IcaCircle score={data.score} size={180} animated />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <MetricCard label="Ingresos"  value={`${data.metrics.monthlyIncome.toLocaleString('es-ES')}€`}  trend="up"   icon="💰" color="#4CAF7D" />
            <MetricCard label="Gastos"    value={`${data.metrics.monthlyExpenses.toLocaleString('es-ES')}€`} trend="down" icon="📊" color="#E8A93C" />
            <MetricCard label="Fugas"     value={data.metrics.leaksDetected} trend={data.metrics.leaksDetected > 0 ? 'down' : 'neutral'} icon="⚠️" color="#E85C5C" />
            <MetricCard label="Ahorro"    value={`${data.metrics.savings.toLocaleString('es-ES')}€`} trend="up" icon="🎯" color="#C9A84C" />
          </div>
        </div>

        {/* ── FAB (mobile only) ── */}
        <div className="md:hidden">
          <button
            className="fab-btn"
            onClick={() => setFabOpen(true)}
            aria-label="Abrir Consigliere"
            style={{
              position: 'fixed',
              bottom: '24px',
              right: '24px',
              width: '64px',
              height: '64px',
              borderRadius: '50%',
              border: '2px solid #C9A84C',
              background: 'white',
              overflow: 'hidden',
              cursor: 'pointer',
              padding: 0,
              zIndex: 50,
            }}
          >
            {/* Crop: show only top 35% of the character */}
            <div style={{ position: 'relative', width: '100%', height: '100%' }}>
              <img
                src="/consigliere.png"
                alt=""
                style={{
                  position: 'absolute',
                  top: 0,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  width: 'auto',
                  height: '286%',
                  maxWidth: 'none',
                }}
              />
            </div>
          </button>

          {/* FAB expanded panel */}
          {fabOpen && (
            <div
              className="fab-panel"
              style={{
                position: 'fixed',
                inset: 0,
                zIndex: 100,
                background: '#F4F1EA',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <div style={{ padding: '16px 16px 0', display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  onClick={() => setFabOpen(false)}
                  aria-label="Cerrar"
                  style={{
                    background: 'white',
                    border: '0.5px solid rgba(26,26,26,0.15)',
                    borderRadius: '50%',
                    width: '36px',
                    height: '36px',
                    cursor: 'pointer',
                    fontSize: '18px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#1A1A1A',
                  }}
                >
                  ×
                </button>
              </div>

              <div style={{ padding: '12px 20px 10px' }}>
                <div
                  style={{
                    background: 'white',
                    border: '0.5px solid rgba(26,26,26,0.1)',
                    borderRadius: '12px 12px 12px 0',
                    padding: '14px 18px',
                    display: 'inline-block',
                    maxWidth: '280px',
                    boxShadow: '0 4px 20px rgba(26,26,26,0.08)',
                  }}
                >
                  <p style={{ fontSize: '14px', fontWeight: 500, color: '#1A1A1A', margin: 0 }}>
                    {speech}
                  </p>
                </div>
              </div>

              <div style={{ padding: '0 20px 14px', display: 'flex', gap: '8px' }}>
                <QuickAction label="Ver ICA"       primary />
                <QuickAction label="Registrar"     />
                <QuickAction label="Analizar"      />
              </div>

              <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
                <img
                  src="/consigliere.png"
                  alt="The Consigliere"
                  className="consigliere-img"
                  style={{ maxHeight: '60vh', maxWidth: '80%', objectFit: 'contain', objectPosition: 'bottom' }}
                />
              </div>

              <div style={{ padding: '16px 20px 32px' }}>
                <ChatInput />
              </div>
            </div>
          )}
        </div>

      </div>
    </>
  )
}

// ── Sub-components ─────────────────────────────────────────────

function QuickAction({ label, primary = false }: { label: string; primary?: boolean }) {
  return (
    <button
      style={{
        background: primary ? '#C9A84C' : 'white',
        color: '#1A1A1A',
        borderRadius: '20px',
        padding: '7px 16px',
        fontSize: '12px',
        fontWeight: 600,
        border: primary ? 'none' : '0.5px solid rgba(26,26,26,0.15)',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  )
}

function ChatInput() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        background: 'white',
        border: '0.5px solid rgba(26,26,26,0.15)',
        borderRadius: '24px',
        padding: '10px 10px 10px 16px',
        boxShadow: '0 2px 12px rgba(26,26,26,0.06)',
      }}
    >
      <input
        type="text"
        placeholder="Pregúntale al Consigliere..."
        style={{ flex: 1, border: 'none', outline: 'none', fontSize: '13px', background: 'transparent', color: '#1A1A1A' }}
      />
      <button
        aria-label="Enviar"
        style={{
          background: '#C9A84C',
          border: 'none',
          borderRadius: '50%',
          width: '30px',
          height: '30px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          fontSize: '14px',
          color: '#1A1A1A',
          flexShrink: 0,
        }}
      >
        →
      </button>
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div style={{ background: '#F4F1EA', minHeight: '100vh' }}>
      {/* Desktop skeleton */}
      <div className="hidden md:grid md:grid-cols-2 max-w-7xl mx-auto px-6 py-8" style={{ columnGap: 0 }}>
        <div className="flex flex-col gap-6 pr-10">
          <div className="animate-pulse space-y-3">
            <div className="h-8 rounded-lg w-64" style={{ background: 'rgba(26,26,26,0.08)' }} />
            <div className="h-4 rounded w-48" style={{ background: 'rgba(26,26,26,0.05)' }} />
          </div>
          <div className="flex justify-center">
            <div className="animate-pulse w-64 h-64 rounded-full" style={{ background: 'rgba(201,168,76,0.12)' }} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="animate-pulse h-28 rounded-lg bg-white" style={{ border: '0.5px solid rgba(26,26,26,0.08)' }} />
            ))}
          </div>
        </div>
        <div className="animate-pulse flex flex-col gap-4 pt-4">
          <div className="h-16 rounded-xl w-72 bg-white" style={{ border: '0.5px solid rgba(26,26,26,0.08)' }} />
          <div className="flex gap-2">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-8 w-24 rounded-full bg-white" style={{ border: '0.5px solid rgba(26,26,26,0.08)' }} />
            ))}
          </div>
          <div className="flex-1 min-h-64 rounded-2xl" style={{ background: 'rgba(201,168,76,0.08)' }} />
        </div>
      </div>
      {/* Mobile skeleton */}
      <div className="md:hidden px-4 py-6">
        <div className="animate-pulse space-y-4">
          <div className="h-7 rounded-lg w-40" style={{ background: 'rgba(26,26,26,0.08)' }} />
          <div className="flex justify-center">
            <div className="w-44 h-44 rounded-full" style={{ background: 'rgba(201,168,76,0.12)' }} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-24 rounded-lg bg-white" style={{ border: '0.5px solid rgba(26,26,26,0.08)' }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function ErrorState({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  return (
    <div style={{ background: '#F4F1EA', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'white', borderRadius: '16px', padding: '40px', maxWidth: '360px', textAlign: 'center', border: '0.5px solid rgba(26,26,26,0.1)', boxShadow: '0 4px 24px rgba(26,26,26,0.06)' }}>
        <div style={{ fontSize: '48px', marginBottom: '16px' }}>⚠️</div>
        <h2 style={{ fontSize: '20px', fontWeight: 700, color: '#1A1A1A', marginBottom: '12px' }}>Error</h2>
        <p style={{ color: 'rgba(26,26,26,0.55)', marginBottom: '24px', fontSize: '14px' }}>
          {error || 'Error al cargar el dashboard'}
        </p>
        <button
          onClick={onRetry}
          style={{ background: '#C9A84C', color: '#1A1A1A', border: 'none', borderRadius: '10px', padding: '12px 28px', fontWeight: 600, cursor: 'pointer', fontSize: '14px' }}
        >
          Reintentar
        </button>
      </div>
    </div>
  )
}
