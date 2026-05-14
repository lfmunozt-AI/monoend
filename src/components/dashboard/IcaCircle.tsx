'use client'

import { useEffect, useState, useMemo } from 'react'

interface IcaCircleProps {
  score: number
  size?: number
  animated?: boolean
}

const getScoreLevel = (score: number): { color: string; label: string } => {
  const clampedScore = Math.max(0, Math.min(100, score))
  
  if (clampedScore <= 30) {
    return { color: '#E85C5C', label: 'Ceguera Financiera' }
  } else if (clampedScore <= 70) {
    return { color: '#E8A93C', label: 'Visión Táctica' }
  } else {
    return { color: '#C9A84C', label: 'Dominio Total' }
  }
}

export default function IcaCircle({ score, size = 240, animated = true }: IcaCircleProps) {
  const [displayScore, setDisplayScore] = useState(animated ? 0 : score)
  const { color, label } = useMemo(() => getScoreLevel(score), [score])
  
  const { strokeWidth, radius, circumference } = useMemo(() => {
    const sw = size * 0.08
    const r = (size - sw) / 2
    const c = 2 * Math.PI * r
    return { strokeWidth: sw, radius: r, circumference: c }
  }, [size])
  
  const offset = useMemo(
    () => circumference - (displayScore / 100) * circumference,
    [circumference, displayScore]
  )

  useEffect(() => {
    if (animated) {
      const duration = 1500
      const steps = 60
      const increment = score / steps
      let current = 0
      
      const timer = setInterval(() => {
        current += increment
        if (current >= score) {
          setDisplayScore(score)
          clearInterval(timer)
        } else {
          setDisplayScore(Math.floor(current))
        }
      }, duration / steps)
      
      return () => clearInterval(timer)
    } else {
      setDisplayScore(score)
    }
  }, [score, animated])

  return (
    <div className="flex flex-col items-center justify-center">
      <div className="relative" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          className="transform -rotate-90"
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            stroke="#F0EDE6"
            strokeWidth={strokeWidth}
            fill="none"
          />
          
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            stroke={color}
            strokeWidth={strokeWidth}
            fill="none"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            style={{
              transition: animated ? 'stroke-dashoffset 1.5s ease-out, stroke 0.5s ease' : 'stroke 0.5s ease'
            }}
          />
        </svg>
        
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div 
            className="text-6xl font-serif font-bold transition-colors duration-500"
            style={{ color }}
          >
            {Math.round(displayScore)}
          </div>
          <div className="text-sm text-gray-500 mt-1">ICA Score</div>
        </div>
      </div>
      
      <div 
        className="mt-4 text-center font-semibold text-lg transition-colors duration-500"
        style={{ color }}
      >
        {label}
      </div>
      
      <div className="mt-2 text-sm text-gray-600 text-center max-w-xs">
        {score <= 30 && 'Necesitas visibilidad urgente de tus finanzas'}
        {score > 30 && score <= 70 && 'Vas por buen camino, sigue optimizando'}
        {score > 70 && 'Tienes control total de tu futuro financiero'}
      </div>
    </div>
  )
}
