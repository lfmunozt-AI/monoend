'use client'

import { useMemo } from 'react'
import TypewriterText from './TypewriterText'

type ConsigliereState = 'idle' | 'thinking' | 'responding' | 'alert' | 'celebrate'

interface ChatMessageProps {
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
  isStreaming?: boolean
  consigliereState?: ConsigliereState
  animate?: boolean
  onTypingDone?: () => void
  onTypingProgress?: () => void
}

export default function ChatMessage({
  role,
  content,
  timestamp,
  isStreaming = false,
  consigliereState = 'idle',
  animate = false,
  onTypingDone,
  onTypingProgress
}: ChatMessageProps) {
  const isUser = role === 'user'
  
  const getAnimationClass = () => {
    switch (consigliereState) {
      case 'thinking':
        return 'state-thinking'
      case 'responding':
        return 'state-responding'
      case 'alert':
        return 'state-alert'
      case 'celebrate':
        return 'state-celebrate'
      default:
        return 'state-breathing'
    }
  }
  
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
    <>
      <style jsx>{`
        @keyframes breathing {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.008); }
        }

        @keyframes nodding {
          0% { transform: rotate(0deg) translateY(0); }
          25% { transform: rotate(-2deg) translateY(-3px); }
          75% { transform: rotate(1.5deg) translateY(-1px); }
          100% { transform: rotate(0deg) translateY(0); }
        }

        @keyframes leanForward {
          0% { transform: translateY(0) rotate(0deg); }
          50% { transform: translateY(-5px) rotate(-1deg); }
          100% { transform: translateY(0) rotate(0deg); }
        }

        @keyframes alertShake {
          0%, 100% { transform: translateX(0); }
          20% { transform: translateX(-4px); }
          40% { transform: translateX(4px); }
          60% { transform: translateX(-3px); }
          80% { transform: translateX(3px); }
        }

        @keyframes celebrate {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.015); }
        }

        .state-breathing {
          animation: breathing 4s ease-in-out infinite;
        }

        .state-thinking {
          animation: leanForward 1.5s ease-in-out infinite;
        }

        .state-responding {
          animation: nodding 0.8s ease-in-out 2;
        }

        .state-alert {
          animation: alertShake 0.5s ease-in-out 1;
        }

        .state-celebrate {
          animation: celebrate 0.6s ease-in-out 3;
        }
      `}</style>
      
      <div className={`flex gap-3 mb-6 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
        {!isUser && (
          <div className="flex-shrink-0">
            <div className={`w-10 h-10 rounded-full bg-gradient-to-br from-[#D9B648] to-[#C9A84C] flex items-center justify-center shadow-md ${getAnimationClass()}`}>
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
          ) : !isUser && animate ? (
            <TypewriterText
              text={content}
              onDone={onTypingDone}
              onProgress={onTypingProgress}
              className="text-sm leading-relaxed whitespace-pre-wrap"
            />
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
    </>
  )
}
