'use client'

import { useEffect, useRef } from 'react'
import { useTypewriter } from '@/hooks/useTypewriter'

interface TypewriterTextProps {
  text: string
  enabled?: boolean
  onDone?: () => void
  onProgress?: () => void
  className?: string
  style?: React.CSSProperties
}

export default function TypewriterText({
  text,
  enabled = true,
  onDone,
  onProgress,
  className = 'text-sm leading-relaxed whitespace-pre-wrap',
  style,
}: TypewriterTextProps) {
  const { displayed, isTyping, skip } = useTypewriter(text, enabled)

  const onDoneRef = useRef(onDone)
  const onProgressRef = useRef(onProgress)

  // Mantiene las refs al día con la última prop antes de que el efecto de
  // abajo las lea, sin mutar refs durante el render.
  useEffect(() => {
    onDoneRef.current = onDone
    onProgressRef.current = onProgress
  })

  useEffect(() => {
    onProgressRef.current?.()
    if (displayed === text) onDoneRef.current?.()
  }, [displayed, text])

  return (
    <>
      <style jsx>{`
        @keyframes typewriter-cursor-blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
        .typewriter-cursor {
          animation: typewriter-cursor-blink 0.8s step-end infinite;
        }
      `}</style>
      <p
        className={className}
        onClick={isTyping ? skip : undefined}
        role={isTyping ? 'button' : undefined}
        aria-label={isTyping ? 'Mostrar respuesta completa' : undefined}
        style={isTyping ? { ...style, cursor: 'pointer' } : style}
      >
        {displayed}
        {isTyping && (
          <span className="typewriter-cursor" style={{ color: '#C9A84C' }} aria-hidden="true">
            ▍
          </span>
        )}
      </p>
    </>
  )
}
