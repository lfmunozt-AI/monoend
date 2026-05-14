'use client'

import { useState, useMemo, useCallback } from 'react'

interface Conversation {
  id: string
  title: string
  lastMessage: string
  timestamp: Date
  messageCount: number
}

interface ConversationSidebarProps {
  conversations: Conversation[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
}

const getRelativeDate = (date: Date): string => {
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))
  
  if (days === 0) return 'Hoy'
  if (days === 1) return 'Ayer'
  if (days < 7) return `Hace ${days} días`
  if (days < 30) return `Hace ${Math.floor(days / 7)} semanas`
  
  return date.toLocaleDateString('es-ES', { 
    day: 'numeric', 
    month: 'short' 
  })
}

export default function ConversationSidebar({ 
  conversations, 
  activeId, 
  onSelect, 
  onNew 
}: ConversationSidebarProps) {
  const [isCollapsed, setIsCollapsed] = useState(false)

  const groupedConversations = useMemo(() => {
    return conversations.reduce((acc, conv) => {
      const relativeDate = getRelativeDate(conv.timestamp)
      if (!acc[relativeDate]) {
        acc[relativeDate] = []
      }
      acc[relativeDate].push(conv)
      return acc
    }, {} as Record<string, Conversation[]>)
  }, [conversations])

  return (
    <>
      <button
        onClick={() => setIsCollapsed(!isCollapsed)}
        className="lg:hidden fixed top-4 left-4 z-50 p-2 bg-white rounded-lg shadow-lg border border-[#E4DFD5]"
      >
        <svg 
          className="w-6 h-6 text-[#1A1A1A]" 
          fill="none" 
          stroke="currentColor" 
          viewBox="0 0 24 24"
        >
          <path 
            strokeLinecap="round" 
            strokeLinejoin="round" 
            strokeWidth={2} 
            d="M4 6h16M4 12h16M4 18h16" 
          />
        </svg>
      </button>

      <div 
        className={`
          fixed lg:relative inset-y-0 left-0 z-40
          w-80 bg-white border-r border-[#E4DFD5] 
          transform transition-transform duration-300 ease-in-out
          ${isCollapsed ? '-translate-x-full lg:translate-x-0' : 'translate-x-0'}
        `}
      >
        <div className="flex flex-col h-full">
          <div className="p-4 border-b border-[#E4DFD5]">
            <button
              onClick={onNew}
              className="w-full px-4 py-3 bg-[#D9B648] text-[#1A1A1A] rounded-lg font-semibold hover:bg-[#D9B648]/90 transition-colors flex items-center justify-center gap-2"
            >
              <svg 
                className="w-5 h-5" 
                fill="none" 
                stroke="currentColor" 
                viewBox="0 0 24 24"
              >
                <path 
                  strokeLinecap="round" 
                  strokeLinejoin="round" 
                  strokeWidth={2} 
                  d="M12 4v16m8-8H4" 
                />
              </svg>
              Nueva Consulta
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
            {Object.keys(groupedConversations).length === 0 ? (
              <div className="p-8 text-center">
                <div className="text-4xl mb-3">💬</div>
                <p className="text-sm text-gray-600">
                  No hay conversaciones aún
                </p>
                <p className="text-xs text-gray-500 mt-2">
                  Inicia una nueva consulta con tu Consigliere
                </p>
              </div>
            ) : (
              Object.entries(groupedConversations).map(([dateLabel, convs]) => (
                <div key={dateLabel} className="mb-4">
                  <div className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    {dateLabel}
                  </div>
                  
                  {convs.map((conv) => (
                    <button
                      key={conv.id}
                      onClick={() => {
                        onSelect(conv.id)
                        setIsCollapsed(true)
                      }}
                      className={`
                        w-full px-4 py-3 text-left hover:bg-[#F0EDE6] transition-colors
                        border-l-4 ${
                          activeId === conv.id 
                            ? 'border-[#D9B648] bg-[#F0EDE6]' 
                            : 'border-transparent'
                        }
                      `}
                    >
                      <div className="flex items-start justify-between gap-2 mb-1">
                        <h3 className="font-medium text-sm text-[#1A1A1A] line-clamp-1">
                          {conv.title}
                        </h3>
                        <span className="text-xs text-gray-500 flex-shrink-0">
                          {conv.messageCount}
                        </span>
                      </div>
                      
                      <p className="text-xs text-gray-600 line-clamp-2">
                        {conv.lastMessage}
                      </p>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>

          <div className="p-4 border-t border-[#E4DFD5] bg-[#F9F9F9]">
            <div className="text-xs text-gray-600 text-center">
              <p className="font-semibold text-[#D9B648] mb-1">Tu Consigliere CFO</p>
              <p>Asesoramiento financiero personalizado</p>
            </div>
          </div>
        </div>
      </div>

      {!isCollapsed && (
        <div 
          className="lg:hidden fixed inset-0 bg-black/50 z-30"
          onClick={() => setIsCollapsed(true)}
        />
      )}
    </>
  )
}
