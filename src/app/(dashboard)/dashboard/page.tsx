'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Sidebar from '@/components/layout/Sidebar'
import { createClient } from '@/lib/supabase/client'

// ══════════════════════════════════════
// Types
// ══════════════════════════════════════

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

type CState = 'breathing' | 'thinking' | 'nodding' | 'celebrate'

// ══════════════════════════════════════
// Helpers
// ══════════════════════════════════════

function getGreeting(name: string): string {
  const h = new Date().getHours()
  const n = name || 'amigo/a'
  if (h >= 0 && h < 6) return `Es tarde, ${n}. Tus finanzas pueden esperar.`
  if (h >= 6 && h < 12) return `Buenos días, ${n}. Revisemos tu plan del día.`
  if (h >= 12 && h < 18) return `¿Cómo van tus números de hoy, ${n}?`
  return `Cierre del día. ¿Registramos las transacciones?`
}

function useAnimatedNumber(target: number, duration = 1800, active = true) {
  const [value, setValue] = useState(0)
  const raf = useRef(0)
  useEffect(() => {
    if (!active) { setValue(target); return }
    const start = performance.now()
    const from = 0
    const tick = (now: number) => {
      const t = Math.min((now - start) / duration, 1)
      const ease = 1 - Math.pow(1 - t, 3)
      setValue(Math.round(from + (target - from) * ease))
      if (t < 1) raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [target, duration, active])
  return value
}

function getIcaLevel(score: number) {
  if (score < 30) return 'Bajo'
  if (score < 50) return 'Parcial'
  if (score < 70) return 'Bueno'
  return 'Completo'
}

function getIdfLevel(score: number) {
  if (score < 30) return { label: 'Bronce', badge: '\u2b1c' }
  if (score < 50) return { label: 'Plata', badge: '\ud83d\udfe6' }
  if (score < 76) return { label: 'Oro', badge: '\ud83d\udfe1' }
  return { label: 'Diamante', badge: '\ud83d\udc8e' }
}

// ══════════════════════════════════════
// Main
// ══════════════════════════════════════

export default function DashboardPage() {
  const router = useRouter()

  // Data
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [userName, setUserName] = useState('')

  // Theme
  const [isDark, setIsDark] = useState(false)

  // Consigliere
  const [cState, setCState] = useState<CState>('breathing')
  const [bubbleText, setBubbleText] = useState('')
  const [bubbleVisible, setBubbleVisible] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [chatSending, setChatSending] = useState(false)
  const [conversationId, setConversationId] = useState<string | null>(null)

  // Fuga modal
  const [fugaModalOpen, setFugaModalOpen] = useState(false)
  const [fugaResolved, setFugaResolved] = useState(false)
  const [revertTimer, setRevertTimer] = useState(0)
  const [toast, setToast] = useState<string | null>(null)
  const revertInterval = useRef<ReturnType<typeof setInterval> | null>(null)
  const preResolveData = useRef<DashboardData | null>(null)

  // Persist dark mode
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

  // Fetch data
  const fetchData = useCallback(async () => {
    try {
      setLoading(true); setError(null)
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const raw = (user.user_metadata?.full_name as string | undefined)
          || (user.user_metadata?.name as string | undefined)
          || user.email?.split('@')[0] || ''
        setUserName(raw ? raw.split(' ')[0] : '')
      }
      const res = await fetch('/api/ica/score')
      if (res.status === 401) { router.push('/login'); return }
      if (!res.ok) throw new Error('Error al cargar datos')
      setData(await res.json())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido')
    } finally { setLoading(false) }
  }, [router])

  useEffect(() => { fetchData() }, [fetchData])

  useEffect(() => {
    if (!loading && data) {
      setBubbleText(getGreeting(userName))
      const t = setTimeout(() => setBubbleVisible(true), 400)
      return () => clearTimeout(t)
    }
  }, [loading, data, userName])

  // Chat send
  const handleSend = useCallback(async (msg: string) => {
    const trimmed = msg.trim()
    if (!trimmed || chatSending) return
    setChatInput(''); setChatSending(true); setCState('thinking')
    try {
      const res = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed, ...(conversationId ? { conversationId } : {}) }),
      })
      if (res.status === 401) { router.push('/login'); return }
      if (!res.ok) throw new Error('Error')
      const json = await res.json() as { message?: string; conversationId?: string }
      if (json.message) {
        setCState('nodding'); setBubbleText(json.message)
        setTimeout(() => setCState('breathing'), 1600)
      }
      if (json.conversationId) setConversationId(json.conversationId)
    } catch {
      setBubbleText('Error al procesar. Inténtalo de nuevo.')
      setCState('breathing')
    } finally { setChatSending(false) }
  }, [chatSending, conversationId, router])

  // Fuga resolution
  const handleResolveFuga = useCallback(() => {
    if (!data) return
    preResolveData.current = { ...data, metrics: { ...data.metrics } }
    const amt = data.metrics.leaksAmount

    setCState('thinking')
    setTimeout(() => {
      setCState('nodding')
      setData(prev => {
        if (!prev) return prev
        const newIdf = Math.min(prev.score + 8, 100)
        return {
          score: newIdf,
          metrics: {
            ...prev.metrics,
            leaksDetected: 0,
            leaksAmount: 0,
            monthlyExpenses: prev.metrics.monthlyExpenses - amt,
            savings: prev.metrics.savings + amt,
          },
        }
      })
      setFugaResolved(true); setFugaModalOpen(false)

      const lvl = getIdfLevel(Math.min((data.score || 0) + 8, 100))
      setToast(`\u00a1\u20ac${amt} recuperados! IDF subi\u00f3 \u2014 nivel ${lvl.badge} ${lvl.label} desbloqueado`)
      setTimeout(() => setToast(null), 4000)

      if ((data.score || 0) + 8 >= 76) {
        setTimeout(() => setCState('celebrate'), 1600)
        setTimeout(() => setCState('breathing'), 3400)
      } else {
        setTimeout(() => setCState('breathing'), 1600)
      }

      // Revert timer
      setRevertTimer(60)
      revertInterval.current = setInterval(() => {
        setRevertTimer(prev => {
          if (prev <= 1) {
            if (revertInterval.current) clearInterval(revertInterval.current)
            return 0
          }
          return prev - 1
        })
      }, 1000)
    }, 900)
  }, [data])

  const handleRevert = useCallback(() => {
    if (!preResolveData.current) return
    setData(preResolveData.current)
    setFugaResolved(false)
    setRevertTimer(0)
    if (revertInterval.current) clearInterval(revertInterval.current)
    setCState('breathing')
    setBubbleText(getGreeting(userName))
  }, [userName])

  // ICA score is independent — only changes when user provides data, not on fuga resolution
  const icaScoreRef = useRef<number | null>(null)
  if (data && icaScoreRef.current === null) {
    icaScoreRef.current = data.score
  }
  const icaScore = icaScoreRef.current ?? 0

  // Animated values
  const animIca = useAnimatedNumber(icaScore, 1800, !loading && !!data)
  const animIdf = useAnimatedNumber(data?.score ?? 0, 1800, !loading && !!data)
  const animIncome = useAnimatedNumber(data?.metrics.monthlyIncome ?? 0, 1800, !loading && !!data)
  const animExpenses = useAnimatedNumber(data?.metrics.monthlyExpenses ?? 0, 1800, !loading && !!data)
  const animLeaks = useAnimatedNumber(data?.metrics.leaksAmount ?? 0, 1800, !loading && !!data)
  const animSavings = useAnimatedNumber(data?.metrics.savings ?? 0, 1800, !loading && !!data)

  // Theme tokens
  const T = isDark ? {
    bg: '#0E0E0E', card: '#1A1A1A', card2: '#141414',
    fg: '#EAE6DC', fg2: '#6A6460', border: 'rgba(255,255,255,.08)', borderWidth: '0.5px',
  } : {
    bg: '#F4F1EA', card: '#FFFFFF', card2: '#F0EDE6',
    fg: '#1A1A1A', fg2: '#7A736C', border: 'rgba(26,26,26,.1)', borderWidth: '0.5px',
  }

  if (loading) return <LoadingSkeleton isDark={isDark} />
  if (error || !data) return <ErrorState error={error} onRetry={fetchData} />

  const icaStroke = (icaScore >= 70) ? '#2D6A4F' : '#92570A'
  const idfStroke = (data.score >= 76) ? '#2D6A4F' : '#C9A84C'
  const idfLevel = getIdfLevel(data.score)
  const saldo = data.metrics.monthlyIncome - data.metrics.monthlyExpenses

  return (
    <>
      <style>{`
        @keyframes breathing{0%,100%{transform:scale(1)}50%{transform:scale(1.008)}}
        @keyframes thinking{0%,100%{transform:scale(1.005) rotate(-1deg) translateY(-4px)}50%{transform:scale(1) rotate(0) translateY(0)}}
        @keyframes nodding{0%{transform:rotate(0) translateY(0)}25%{transform:rotate(-2deg) translateY(-3px)}75%{transform:rotate(1.5deg) translateY(-1px)}100%{transform:rotate(0) translateY(0)}}
        @keyframes celebrate{0%,100%{transform:scale(1) translateY(0)}50%{transform:scale(1.018) translateY(-5px)}}
        @keyframes strokeIn{from{stroke-dashoffset:var(--circ)}to{stroke-dashoffset:var(--offset)}}
        @keyframes bubbleIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        @keyframes toastIn{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
        .state-breathing{animation:breathing 4s ease-in-out infinite}
        .state-thinking{animation:thinking 1.5s ease-in-out infinite}
        .state-nodding{animation:nodding .8s ease-in-out 2}
        .state-celebrate{animation:celebrate .6s ease-in-out 3}
        .bubble-in{animation:bubbleIn .5s ease forwards}
        .toast-in{animation:toastIn .4s ease forwards}
        .stroke-animate{animation:strokeIn 1.8s cubic-bezier(.22,.61,.36,1) forwards}
      `}</style>

      <Sidebar isDark={isDark} onToggleDark={toggleDark} />

      <div style={{ marginLeft: '220px', background: T.bg, minHeight: '100vh', display: 'flex', flexDirection: 'column', transition: 'background .3s' }}>
        {/* Main area */}
        <div style={{ flex: 1, padding: '28px 32px', display: 'grid', gridTemplateColumns: '55% 45%', gap: '24px' }}>

          {/* ═══ LEFT COLUMN ═══ */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

            {/* ICA row */}
            <div style={{ background: T.card2, borderRadius: '12px', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: '16px', border: `${T.borderWidth} solid ${T.border}` }}>
              <IcaMini score={animIca} realScore={icaScore} stroke={icaStroke} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '13px', color: T.fg2, marginBottom: '2px' }}>Lo que sé de ti</div>
                <div style={{ fontSize: '15px', fontWeight: 600, color: T.fg }}>{getIcaLevel(icaScore)}</div>
                <div style={{ fontSize: '11px', color: T.fg2, marginTop: '4px' }}>
                  Sube tu extracto bancario para mejorar mis proyecciones
                </div>
              </div>
            </div>

            {/* IDF hero */}
            <div style={{ background: T.card, borderRadius: '14px', padding: '28px', border: `${T.borderWidth} solid ${T.border}`, textAlign: 'center' }}>
              <div style={{ fontSize: '13px', color: T.fg2, marginBottom: '4px' }}>Tu progreso hacia</div>
              <div style={{ fontSize: '17px', fontWeight: 700, color: T.fg, marginBottom: '16px' }}>
                Tu primera meta financiera
              </div>
              <IdfCircle score={animIdf} realScore={data.score} stroke={idfStroke} />
              <div style={{ marginTop: '14px', fontSize: '13px', color: T.fg2 }}>
                {idfLevel.badge} {idfLevel.label}
              </div>
              {/* Progress bar */}
              <div style={{ marginTop: '12px', height: '6px', borderRadius: '3px', background: T.card2, overflow: 'hidden' }}>
                <div style={{ width: `${data.score}%`, height: '100%', background: idfStroke, borderRadius: '3px', transition: 'width 1.8s cubic-bezier(.22,.61,.36,1)' }} />
              </div>
              <div style={{ fontSize: '11px', color: T.fg2, marginTop: '8px' }}>
                +5 pts este mes · {idfLevel.badge} a los 76%
              </div>
            </div>

            {/* Metric cards 2x2 */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <Card t={T} label="Ingresos" value={`${animIncome.toLocaleString('es-ES')}\u20ac`} color="#2D6A4F" trendUp />
              <Card t={T} label="Gastos" value={`${animExpenses.toLocaleString('es-ES')}\u20ac`} color={T.fg} />
              <div style={{
                background: fugaResolved ? T.card : T.card, borderRadius: '12px',
                padding: '16px 18px', border: `${T.borderWidth} solid ${fugaResolved ? '#2D6A4F' : T.border}`,
                display: 'flex', flexDirection: 'column', gap: '6px',
              }}>
                <div style={{ fontSize: '11px', color: T.fg2, textTransform: 'uppercase', letterSpacing: '.5px' }}>Fugas detectadas</div>
                <div style={{ fontSize: '24px', fontWeight: 700, color: fugaResolved ? '#2D6A4F' : '#8B2635' }}>
                  {fugaResolved ? '0\u20ac' : `${animLeaks.toLocaleString('es-ES')}\u20ac`}
                </div>
                {!fugaResolved ? (
                  <button
                    onClick={() => setFugaModalOpen(true)}
                    style={{
                      background: 'rgba(139,38,53,.08)', border: '1px solid rgba(139,38,53,.2)',
                      borderRadius: '6px', padding: '5px 10px', color: '#8B2635',
                      fontSize: '11px', fontWeight: 600, cursor: 'pointer', marginTop: '4px',
                    }}
                  >
                    Ya la resolví ✓
                  </button>
                ) : revertTimer > 0 ? (
                  <button
                    onClick={() => {
                      setFugaModalOpen(true)
                    }}
                    style={{
                      background: 'rgba(45,106,79,.08)', border: '1px solid rgba(45,106,79,.2)',
                      borderRadius: '6px', padding: '5px 10px', color: '#2D6A4F',
                      fontSize: '11px', fontWeight: 600, cursor: 'pointer', marginTop: '4px',
                    }}
                  >
                    Revertir ↩ ({revertTimer}s)
                  </button>
                ) : null}
              </div>
              <Card t={T} label="Saldo fin de mes" value={`${Math.max(0, saldo).toLocaleString('es-ES')}\u20ac`} color="#2D6A4F" trendUp />
            </div>
          </div>

          {/* ═══ RIGHT COLUMN — Consigliere ═══ */}
          <div style={{ display: 'flex', flexDirection: 'column', background: T.card, borderRadius: '14px', border: `${T.borderWidth} solid ${T.border}`, padding: '20px', overflow: 'hidden' }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
              <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#2D6A4F' }} />
              <span style={{ fontSize: '14px', fontWeight: 600, color: T.fg }}>The Consigliere</span>
              <span style={{ fontSize: '11px', color: T.fg2 }}>activo</span>
            </div>

            {/* Character + Bubble zone */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', minHeight: '200px', position: 'relative' }}>
              {/* Bubble above character */}
              {bubbleVisible && (
                <div className="bubble-in" style={{
                  background: T.card2, border: '1px solid rgba(201,168,76,.38)',
                  borderRadius: '12px 12px 12px 3px', padding: '14px 18px',
                  maxWidth: '280px', maxHeight: '120px', overflowY: 'auto',
                  marginBottom: '12px',
                }}>
                  <p style={{ fontSize: '14px', fontWeight: 500, color: T.fg, margin: 0, lineHeight: '1.5' }}>
                    {chatSending ? 'El Consigliere está pensando…' : bubbleText}
                  </p>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <img
                  src="/consigliere.png"
                  alt="The Consigliere"
                  className={`state-${cState}`}
                  style={{ maxHeight: '42vh', width: 'auto', objectFit: 'contain', objectPosition: 'bottom' }}
                />
              </div>
            </div>

            {/* Quick actions */}
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '14px', marginBottom: '12px' }}>
              {['\u00bfCómo resolver las fugas?', 'Proyección a la meta', 'Resumen del mes'].map(q => (
                <button key={q} onClick={() => handleSend(q)} style={{
                  background: T.card2, border: `1px solid ${T.border}`, borderRadius: '18px',
                  padding: '6px 14px', fontSize: '12px', fontWeight: 500, color: T.fg2,
                  cursor: 'pointer', whiteSpace: 'nowrap',
                }}>
                  {q}
                </button>
              ))}
            </div>

            {/* Input */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              background: T.card2, border: `1px solid ${T.border}`,
              borderRadius: '24px', padding: '8px 8px 8px 16px',
            }}>
              <input
                type="text"
                placeholder="Pregunta al Consigliere..."
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(chatInput) } }}
                disabled={chatSending}
                style={{
                  flex: 1, border: 'none', outline: 'none', background: 'transparent',
                  fontSize: '13px', color: T.fg,
                }}
              />
              <button
                onClick={() => handleSend(chatInput)}
                disabled={chatSending || !chatInput.trim()}
                aria-label="Enviar"
                style={{
                  width: '32px', height: '32px', borderRadius: '50%', border: 'none',
                  background: chatSending || !chatInput.trim() ? 'rgba(201,168,76,.4)' : '#C9A84C',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: chatSending || !chatInput.trim() ? 'default' : 'pointer',
                  color: '#1A1A1A', fontSize: '15px', flexShrink: 0,
                }}
              >
                →
              </button>
            </div>
          </div>
        </div>

        {/* ═══ BOTTOM BAR ═══ */}
        <div style={{
          padding: '12px 32px', borderTop: `1px solid ${T.border}`,
          display: 'flex', gap: '10px', flexWrap: 'wrap',
        }}>
          <Tag t={T} label="Transacciones recientes" />
          {data.metrics.leaksDetected > 0 && !fugaResolved && (
            <Tag t={T} label={`${data.metrics.leaksDetected} fugas activas`} danger />
          )}
          <Tag t={T} label={`Reporte ${new Date().toLocaleDateString('es-ES', { month: 'long' })} disponible`} />
          {(new Date().getMonth() === 4 || new Date().getMonth() === 5) && (
            <Tag t={T} label="Subsidio vacaciones · jun" />
          )}
        </div>
      </div>

      {/* ═══ MODAL FUGAS ═══ */}
      {fugaModalOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setFugaModalOpen(false)}>
          <div onClick={e => e.stopPropagation()} style={{
            background: T.card, borderRadius: '16px', padding: '32px', maxWidth: '420px', width: '90%',
            border: `1px solid ${T.border}`,
          }}>
            {!fugaResolved ? (
              <>
                <h3 style={{ fontSize: '17px', fontWeight: 700, color: T.fg, marginBottom: '14px' }}>
                  ¿Confirmás que ya resolviste esta fuga fuera del sistema?
                </h3>
                <p style={{ fontSize: '14px', color: T.fg2, lineHeight: '1.6', marginBottom: '24px' }}>
                  The Consigliere actualizará tus proyecciones basándose en tu confirmación.
                  Si aún no la resolviste, hazlo primero en tu banco o proveedor — el sistema
                  no puede hacerlo por ti todavía.
                </p>
                <div style={{ display: 'flex', gap: '12px' }}>
                  <button onClick={handleResolveFuga} style={{
                    flex: 1, padding: '12px', borderRadius: '10px', border: 'none',
                    background: '#C9A84C', color: '#1A1A1A', fontWeight: 600, fontSize: '14px', cursor: 'pointer',
                  }}>
                    Sí, ya la resolví
                  </button>
                  <button onClick={() => setFugaModalOpen(false)} style={{
                    flex: 1, padding: '12px', borderRadius: '10px',
                    background: 'transparent', border: `1px solid ${T.border}`,
                    color: T.fg, fontWeight: 500, fontSize: '14px', cursor: 'pointer',
                  }}>
                    Todavía no
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 style={{ fontSize: '17px', fontWeight: 700, color: T.fg, marginBottom: '14px' }}>
                  ¿Revertir la resolución de esta fuga?
                </h3>
                <p style={{ fontSize: '14px', color: T.fg2, lineHeight: '1.6', marginBottom: '24px' }}>
                  Las métricas volverán a su estado anterior.
                </p>
                <div style={{ display: 'flex', gap: '12px' }}>
                  <button onClick={() => { handleRevert(); setFugaModalOpen(false) }} style={{
                    flex: 1, padding: '12px', borderRadius: '10px', border: 'none',
                    background: '#8B2635', color: '#fff', fontWeight: 600, fontSize: '14px', cursor: 'pointer',
                  }}>
                    Sí, revertir
                  </button>
                  <button onClick={() => setFugaModalOpen(false)} style={{
                    flex: 1, padding: '12px', borderRadius: '10px',
                    background: 'transparent', border: `1px solid ${T.border}`,
                    color: T.fg, fontWeight: 500, fontSize: '14px', cursor: 'pointer',
                  }}>
                    Cancelar
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ═══ TOAST ═══ */}
      {toast && (
        <div className="toast-in" style={{
          position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
          background: '#2D6A4F', color: '#fff', padding: '14px 24px', borderRadius: '10px',
          fontSize: '14px', fontWeight: 600, zIndex: 200, boxShadow: '0 8px 32px rgba(0,0,0,.2)',
          maxWidth: '420px', textAlign: 'center',
        }}>
          {toast}
        </div>
      )}
    </>
  )
}

// ══════════════════════════════════════
// Sub-components
// ══════════════════════════════════════

function IcaMini({ score, realScore, stroke }: { score: number; realScore: number; stroke: string }) {
  const r = 20, circ = 2 * Math.PI * r
  const offset = circ - (circ * realScore) / 100
  return (
    <svg width="50" height="50" viewBox="0 0 50 50">
      <circle cx="25" cy="25" r={r} fill="none" stroke="rgba(146,87,10,.15)" strokeWidth="4" />
      <circle cx="25" cy="25" r={r} fill="none" stroke={stroke} strokeWidth="4"
        strokeLinecap="round" transform="rotate(-90 25 25)"
        strokeDasharray={circ} strokeDashoffset={offset}
        className="stroke-animate"
        style={{ '--circ': circ, '--offset': offset } as React.CSSProperties}
      />
      <text x="25" y="26" textAnchor="middle" dominantBaseline="middle"
        style={{ fontSize: '12px', fontWeight: 700, fill: stroke }}>
        {score}%
      </text>
    </svg>
  )
}

function IdfCircle({ score, realScore, stroke }: { score: number; realScore: number; stroke: string }) {
  const r = 32, circ = 2 * Math.PI * r
  const offset = circ - (circ * realScore) / 100
  return (
    <svg width="76" height="76" viewBox="0 0 76 76">
      <circle cx="38" cy="38" r={r} fill="none" stroke="rgba(201,168,76,.12)" strokeWidth="5" />
      <circle cx="38" cy="38" r={r} fill="none" stroke={stroke} strokeWidth="5"
        strokeLinecap="round" transform="rotate(-90 38 38)"
        strokeDasharray={circ} strokeDashoffset={offset}
        className="stroke-animate"
        style={{ '--circ': circ, '--offset': offset } as React.CSSProperties}
      />
      <text x="38" y="39" textAnchor="middle" dominantBaseline="middle"
        style={{ fontSize: '18px', fontWeight: 700, fill: stroke }}>
        {score}%
      </text>
    </svg>
  )
}

interface ThemeTokens { bg: string; card: string; card2: string; fg: string; fg2: string; border: string; borderWidth: string }

function Card({ t, label, value, color, trendUp }: { t: ThemeTokens; label: string; value: string; color: string; trendUp?: boolean }) {
  return (
    <div style={{
      background: t.card, borderRadius: '12px', padding: '16px 18px',
      border: `${t.borderWidth} solid ${t.border}`, display: 'flex', flexDirection: 'column', gap: '6px',
    }}>
      <div style={{ fontSize: '11px', color: t.fg2, textTransform: 'uppercase', letterSpacing: '.5px' }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span style={{ fontSize: '24px', fontWeight: 700, color }}>{value}</span>
        {trendUp && (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        )}
      </div>
    </div>
  )
}

function Tag({ t, label, danger = false }: { t: ThemeTokens; label: string; danger?: boolean }) {
  return (
    <span style={{
      background: danger ? 'rgba(139,38,53,.08)' : t.card2,
      border: `1px solid ${danger ? 'rgba(139,38,53,.2)' : t.border}`,
      borderRadius: '16px', padding: '5px 14px',
      fontSize: '12px', fontWeight: 500,
      color: danger ? '#8B2635' : t.fg2,
    }}>
      {label}
    </span>
  )
}

function LoadingSkeleton({ isDark }: { isDark: boolean }) {
  const bg = isDark ? '#0E0E0E' : '#F4F1EA'
  const sh = isDark ? 'rgba(255,255,255,.04)' : 'rgba(26,26,26,.06)'
  const sh2 = isDark ? 'rgba(255,255,255,.02)' : 'rgba(26,26,26,.03)'
  return (
    <div style={{ background: bg, minHeight: '100vh', marginLeft: '220px', padding: '28px 32px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '55% 45%', gap: '24px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div className="animate-pulse" style={{ height: '72px', borderRadius: '12px', background: sh }} />
          <div className="animate-pulse" style={{ height: '220px', borderRadius: '14px', background: sh }} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            {[1,2,3,4].map(i => <div key={i} className="animate-pulse" style={{ height: '90px', borderRadius: '12px', background: sh }} />)}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div className="animate-pulse" style={{ height: '64px', borderRadius: '12px', background: sh, maxWidth: '260px' }} />
          <div style={{ display: 'flex', gap: '8px' }}>{[1,2,3].map(i => <div key={i} className="animate-pulse" style={{ height: '30px', width: '100px', borderRadius: '18px', background: sh }} />)}</div>
          <div className="animate-pulse" style={{ flex: 1, minHeight: '280px', borderRadius: '16px', background: sh2 }} />
        </div>
      </div>
    </div>
  )
}

function ErrorState({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  return (
    <div style={{ background: '#F4F1EA', minHeight: '100vh', marginLeft: '220px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: '16px', padding: '40px', maxWidth: '380px', textAlign: 'center', border: '1px solid rgba(26,26,26,.1)' }}>
        <h2 style={{ fontSize: '20px', fontWeight: 700, color: '#1A1A1A', marginBottom: '12px' }}>Error al cargar</h2>
        <p style={{ color: '#7A736C', marginBottom: '24px', fontSize: '14px' }}>{error || 'Error desconocido'}</p>
        <button onClick={onRetry} style={{
          background: '#C9A84C', color: '#1A1A1A', border: 'none', borderRadius: '10px',
          padding: '12px 28px', fontWeight: 600, cursor: 'pointer', fontSize: '14px',
        }}>Reintentar</button>
      </div>
    </div>
  )
}
