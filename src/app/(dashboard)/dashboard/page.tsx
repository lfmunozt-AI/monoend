'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import IcaCircle from '@/components/dashboard/IcaCircle'
import MetricCard from '@/components/dashboard/MetricCard'
import Sidebar from '@/components/layout/Sidebar'
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

function getTimeGreeting(name: string): string {
  const hour = new Date().getHours()
  if (hour >= 6 && hour < 12) return `Buenos días, ${name}. Revisemos tu plan del día.`
  if (hour >= 12 && hour < 18) return `¿Cómo van tus números de hoy, ${name}?`
  return `Cierre del día. ¿Registramos las transacciones?`
}

export default function DashboardPage() {
  const router = useRouter()
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [userName, setUserName] = useState('Tú')
  const [fabOpen, setFabOpen] = useState(false)
  const [bubbleVisible, setBubbleVisible] = useState(false)
  const [consigliereState, setConsigliereState] = useState<'idle' | 'thinking' | 'responding'>('idle')

  // --- Chat state ---
  const [bubbleText, setBubbleText] = useState('')
  const [chatInput, setChatInput] = useState('')
  const [chatSending, setChatSending] = useState(false)
  const [conversationId, setConversationId] = useState<string | null>(null)

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
      if (response.status === 401) { router.push('/login'); return }
      if (!response.ok) throw new Error('Error al cargar datos del dashboard')
      setData(await response.json())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido')
    } finally {
      setLoading(false)
    }
  }, [router])

  useEffect(() => { fetchData() }, [fetchData])

  useEffect(() => {
    if (!loading && data) {
      setBubbleText(getTimeGreeting(userName))
      const t = setTimeout(() => setBubbleVisible(true), 400)
      return () => clearTimeout(t)
    }
  }, [loading, data, userName])

  useEffect(() => {
    console.log('[Consigliere State]:', consigliereState)
  }, [consigliereState])

  // --- PROBLEMA 1: Send handler conectado al chat ---
  const handleSend = useCallback(async (message: string) => {
    const trimmed = message.trim()
    if (!trimmed || chatSending) return
    setChatInput('')
    setChatSending(true)
    setConsigliereState('thinking')
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          ...(conversationId ? { conversationId } : {}),
        }),
      })
      if (res.status === 401) { router.push('/login'); return }
      if (!res.ok) throw new Error('Error en la respuesta')
      const json = await res.json() as { message?: string; conversationId?: string }
      if (json.message) {
        setConsigliereState('responding')
        setBubbleText(json.message)
        setTimeout(() => setConsigliereState('idle'), 1600)
      }
      if (json.conversationId) setConversationId(json.conversationId)
    } catch {
      setBubbleText('Lo siento, no pude procesar tu mensaje. Inténtalo de nuevo.')
      setConsigliereState('idle')
    } finally {
      setChatSending(false)
    }
  }, [chatSending, conversationId, router])

  if (loading) return <LoadingSkeleton />
  if (error || !data) return <ErrorState error={error} onRetry={fetchData} />

  return (
    <>
      <style>{`
        @keyframes breathing {
          0%, 100% { transform: scale(1); }
          50%       { transform: scale(1.008); }
        }
        @keyframes leanForward {
          0% { transform: translateY(0) rotate(0deg); }
          50% { transform: translateY(-5px) rotate(-1deg); }
          100% { transform: translateY(0) rotate(0deg); }
        }
        @keyframes nodding {
          0% { transform: rotate(0deg) translateY(0); }
          25% { transform: rotate(-2deg) translateY(-3px); }
          75% { transform: rotate(1.5deg) translateY(-1px); }
          100% { transform: rotate(0deg) translateY(0); }
        }
        .state-breathing { animation: breathing 4s ease-in-out infinite; }
        .state-thinking { animation: leanForward 1.5s ease-in-out infinite; }
        .state-responding { animation: nodding 0.8s ease-in-out 2; }
      `}</style>

      <Sidebar />

      <div style={{ marginLeft: '256px', background: '#F9F9F9', minHeight: '100vh', padding: '32px' }}>

        <div style={{ maxWidth: '1400px', margin: '0 auto' }}>
          <div className="grid grid-cols-[55%_45%] gap-8">
            {/* Left column: ICA + Metrics */}
            <div className="flex flex-col gap-6">
              <div>
                <h1 className="text-3xl font-bold mb-1" style={{ color: '#1A1A1A' }}>
                  Tu Dominio Financiero
                </h1>
                <p className="text-sm" style={{ color: 'rgba(26,26,26,0.45)' }}>
                  {new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })}
                </p>
              </div>

              <div className="flex justify-center py-4">
                <IcaCircle score={data.score} size={280} animated />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <MetricCard 
                  label="Ingresos del Mes" 
                  value={`${data.metrics.monthlyIncome.toLocaleString('es-ES')}€`} 
                  trend="up" 
                  color="#4CAF7D" 
                />
                <MetricCard 
                  label="Gastos del Mes" 
                  value={`${data.metrics.monthlyExpenses.toLocaleString('es-ES')}€`} 
                  trend="up" 
                  color="#E85C5C" 
                />
                <MetricCard 
                  label="Fugas Detectadas" 
                  value={data.metrics.leaksDetected.toString()} 
                  trend={data.metrics.leaksDetected > 0 ? 'down' : 'neutral'} 
                  color="#E85C5C" 
                />
                <MetricCard 
                  label="Ahorro del Mes" 
                  value={`${data.metrics.savings.toLocaleString('es-ES')}€`} 
                  trend="up" 
                  color="#4CAF7D" 
                />
              </div>
            </div>

            {/* Right column: Consigliere anclado al fondo */}
            <div className="relative flex flex-col justify-end" style={{ minHeight: '80vh' }}>
              {/* Burbuja conectada al personaje */}
              {bubbleVisible && (
                <div
                  style={{
                    background: 'white',
                    border: '1px solid rgba(26,26,26,0.1)',
                    borderRadius: '12px 12px 0px 12px',
                    padding: '16px',
                    maxWidth: '280px',
                    boxShadow: '0 4px 20px rgba(26,26,26,0.08)',
                    marginBottom: '16px',
                    maxHeight: '120px',
                    overflowY: 'auto',
                  }}
                >
                  <p style={{ fontSize: '14px', fontWeight: 500, color: '#1A1A1A', margin: 0, lineHeight: '1.5' }}>
                    {chatSending ? 'El Consigliere está pensando…' : bubbleText}
                  </p>
                </div>
              )}

              {/* Personaje anclado al fondo */}
              <div className="flex justify-center">
                <img
                  src="/consigliere.png"
                  alt="The Consigliere"
                  className={`state-${consigliereState}`}
                  style={{ maxHeight: '50vh', width: 'auto', objectFit: 'contain', objectPosition: 'bottom' }}
                />
              </div>

              {/* Chat input */}
              <div style={{ marginTop: '16px' }}>
                <ChatInput
                  value={chatInput}
                  onChange={setChatInput}
                  onSend={handleSend}
                  loading={chatSending}
                />
              </div>
            </div>
          </div>
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

interface ChatInputProps {
  value: string
  onChange: (v: string) => void
  onSend: (message: string) => void
  loading?: boolean
}

function ChatInput({ value, onChange, onSend, loading = false }: ChatInputProps) {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSend(value)
    }
  }

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: '8px',
        background: 'white', border: '0.5px solid rgba(26,26,26,0.15)',
        borderRadius: '24px', padding: '10px 10px 10px 16px',
        boxShadow: '0 2px 12px rgba(26,26,26,0.06)',
        opacity: loading ? 0.7 : 1,
        transition: 'opacity 0.2s',
      }}
    >
      <input
        type="text"
        placeholder="Pregúntale al Consigliere..."
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={loading}
        style={{
          flex: 1, border: 'none', outline: 'none',
          fontSize: '13px', background: 'transparent', color: '#1A1A1A',
        }}
      />
      <button
        aria-label="Enviar"
        onClick={() => onSend(value)}
        disabled={loading || !value.trim()}
        style={{
          background: loading || !value.trim() ? 'rgba(201,168,76,0.5)' : '#C9A84C',
          border: 'none', borderRadius: '50%',
          width: '30px', height: '30px',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: loading || !value.trim() ? 'default' : 'pointer',
          fontSize: '14px', color: '#1A1A1A', flexShrink: 0,
          transition: 'background 0.2s',
        }}
      >
        {loading ? '…' : '→'}
      </button>
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div style={{ background: '#F4F1EA', minHeight: '100vh' }}>
      <div style={{ maxWidth: '1280px', margin: '0 auto', padding: '0 24px' }}>
        <div className="hidden md:grid md:grid-cols-2" style={{ paddingTop: '32px', columnGap: 0 }}>
          <div className="flex flex-col gap-6" style={{ paddingRight: '40px' }}>
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
        <div className="md:hidden" style={{ paddingTop: '24px' }}>
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
