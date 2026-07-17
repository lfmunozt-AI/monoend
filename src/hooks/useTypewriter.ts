import { useCallback, useEffect, useRef, useState } from 'react'

// Presentación, no generación: el texto ya llegó completo y validado
// (ver docs/STREAMING_BUFFER_DESIGN.md — Opción B). Este hook solo simula
// el tipeo en cliente; nunca toca la capa de red ni el guardrail.
const TOTAL_BUDGET_MS = 1900
const MIN_TICK_MS = 8
const MAX_TICK_MS = 30

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false
  )

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  return reduced
}

interface UseTypewriterResult {
  displayed: string
  isTyping: boolean
  skip: () => void
}

export function useTypewriter(text: string, enabled: boolean): UseTypewriterResult {
  const reducedMotion = usePrefersReducedMotion()
  const animate = enabled && !reducedMotion && text.length > 0

  const [displayed, setDisplayed] = useState(animate ? '' : text)
  const [isTyping, setIsTyping] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const skip = useCallback(() => {
    clearTimer()
    setDisplayed(text)
    setIsTyping(false)
  }, [clearTimer, text])

  useEffect(() => {
    clearTimer()

    if (!animate) {
      // Espejo puro de la prop, sin timers que sincronizar. El setState se
      // agenda dentro de un callback (no en el cuerpo síncrono del efecto)
      // para respetar las reglas del compilador de React.
      timerRef.current = setTimeout(() => {
        setDisplayed(text)
        setIsTyping(false)
        timerRef.current = null
      }, 0)
      return clearTimer
    }

    const tokens = text.match(/\S+\s*/g) ?? [text]
    const tickMs = Math.min(MAX_TICK_MS, Math.max(MIN_TICK_MS, TOTAL_BUDGET_MS / tokens.length))

    let i = 0
    const step = () => {
      i += 1
      setDisplayed(tokens.slice(0, i).join(''))
      setIsTyping(i < tokens.length)
      if (i >= tokens.length) {
        timerRef.current = null
        return
      }
      timerRef.current = setTimeout(step, tickMs)
    }
    // Primera palabra visible <100ms: se agenda con delay 0 en vez de
    // pintarse en el cuerpo síncrono del efecto.
    timerRef.current = setTimeout(step, 0)

    return clearTimer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, animate])

  return { displayed, isTyping, skip }
}
