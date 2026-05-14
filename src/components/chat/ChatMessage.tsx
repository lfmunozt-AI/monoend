'use client'

import { useMemo } from 'react'

interface ChatMessageProps {
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
  isStreaming?: boolean
}

export default function ChatMessage({ role, content, timestamp, isStreaming = false }: ChatMessageProps) {
  const isUser = role === 'user'
  
  const formattedTimestamp = useMemo(() => {
    const now = new Date()
    const diff = now.getTime() - timestamp.getTime()
    const minutes = Math.floor(diff / 60000)
    
    if (minutes < 1) return 'Ahora'
    if (minutes < 60) return `Hace ${minutes}m`
    
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `Hace ${hours}h`
    
    return timestamp.toLocaleDateString('es-ES', { 
      day: 'numeric', 
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    })
  }, [timestamp])

  return (
    <div className={`flex gap-3 mb-6 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      {!isUser && (
        <div className="flex-shrink-0">
          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#D9B648] to-[#C9A84C] flex items-center justify-center shadow-md">
            <span className="text-white text-xs font-bold">CFO</span>
          </div>
        </div>
      )}
      
      <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} max-w-[75%]`}>
        <div
          className={`px-4 py-3 rounded-2xl ${
            isUser
              ? 'bg-[#D9B648]/20 text-[#1A1A1A] rounded-tr-sm'
              : 'bg-[#F0EDE6] text-[#1A1A1A] rounded-tl-sm'
          }`}
        >
          {isStreaming ? (
            <div className="flex items-center gap-1">
              <div className="flex gap-1">
                <span className="w-2 h-2 bg-[#D9B648] rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></span>
                <span className="w-2 h-2 bg-[#D9B648] rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></span>
                <span className="w-2 h-2 bg-[#D9B648] rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></span>
              </div>
            </div>
          ) : (
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{content}</p>
          )}
        </div>
        
        <span className="text-xs text-gray-500 mt-1 px-2">
          {formattedTimestamp}
        </span>
      </div>
      
      {isUser && (
        <div className="flex-shrink-0">
          <div className="w-10 h-10 rounded-full bg-[#1A1A1A] flex items-center justify-center">
            <span className="text-white text-xs font-bold">TÚ</span>
          </div>
        </div>
      )}
    </div>
  )
}
