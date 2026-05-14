'use client'

import { ReactNode } from 'react'

interface MetricCardProps {
  label: string
  value: string | number
  trend?: 'up' | 'down' | 'neutral'
  icon?: ReactNode
  color?: string
}

export default function MetricCard({ 
  label, 
  value, 
  trend, 
  icon, 
  color = '#D9B648' 
}: MetricCardProps) {
  const getTrendIcon = () => {
    if (trend === 'up') return '↑'
    if (trend === 'down') return '↓'
    return '→'
  }

  const getTrendColor = () => {
    if (trend === 'up') return '#4CAF7D'
    if (trend === 'down') return '#E85C5C'
    return '#6B6B6B'
  }

  return (
    <div className="bg-white rounded-lg border-2 border-[#E4DFD5] p-6 hover:border-[#D9B648] transition-colors">
      <div className="flex items-start justify-between mb-4">
        <div className="text-sm font-medium text-gray-600 uppercase tracking-wide">
          {label}
        </div>
        {icon && (
          <div style={{ color }} className="text-2xl">
            {icon}
          </div>
        )}
      </div>
      
      <div className="flex items-end justify-between">
        <div className="text-3xl font-bold text-[#1A1A1A]">
          {value}
        </div>
        
        {trend && (
          <div 
            className="text-2xl font-bold mb-1"
            style={{ color: getTrendColor() }}
          >
            {getTrendIcon()}
          </div>
        )}
      </div>
    </div>
  )
}
