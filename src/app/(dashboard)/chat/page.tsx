'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import ChatMessage from '@/components/chat/ChatMessage'
import ChatInput from '@/components/chat/ChatInput'
import ConversationSidebar from '@/components/chat/ConversationSidebar'

type ConsigliereState = 'idle' | 'thinking' | 'responding' | 'alert' | 'celebrate'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
}

interface Conversation {
  id: string
  title: string
  lastMessage: string
  timestamp: Date
  messageCount: number
}

export default function ChatPage() {
  const router = useRouter()
  const [messages, setMessages] = useState<Message[]>([])
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isStreaming, setIsStreaming] = useState(false)
  const [consigliereState, setConsigliereState] = useState<ConsigliereState>('idle')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    loadConversations()
    loadActiveConversation()
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [messages, isStreaming])

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  const loadConversations = async () => {
    try {
      const response = await fetch('/api/chat/history')
      
      if (response.status === 401) {
        router.push('/login')
        return
      }

      if (!response.ok) {
        throw new Error('Error al cargar conversaciones')
      }

      const data = await response.json()
      setConversations(data.conversations.map((conv: any) => ({
        id: conv.id,
        title: conv.title ?? 'Nueva conversación',
        lastMessage: conv.lastMessage?.content ?? '',
        timestamp: new Date(conv.updatedAt ?? conv.createdAt),
        messageCount: 0,
      })))
    } catch (error) {
      console.error('Error loading conversations:', error)
    }
  }

  const loadActiveConversation = () => {
    const savedConvId = localStorage.getItem('activeConversationId')
    // Only restore real DB UUIDs — skip any stale local temp IDs
    if (savedConvId && !savedConvId.startsWith('conv_')) {
      setActiveConversationId(savedConvId)
      loadMessages(savedConvId)
    }
  }

  const loadMessages = (conversationId: string) => {
    const savedMessages = localStorage.getItem(`messages_${conversationId}`)
    if (savedMessages) {
      const parsed = JSON.parse(savedMessages)
      setMessages(parsed.map((msg: any) => ({
        ...msg,
        timestamp: new Date(msg.timestamp)
      })))
    }
  }

  const saveMessages = useCallback((convId: string | null, msgs: Message[]) => {
    if (convId) localStorage.setItem(`messages_${convId}`, JSON.stringify(msgs))
  }, [])

  const startNewConversation = () => {
    setActiveConversationId(null)
    setMessages([])
    localStorage.removeItem('activeConversationId')
  }

  const handleSelectConversation = (conversationId: string) => {
    setActiveConversationId(conversationId)
    localStorage.setItem('activeConversationId', conversationId)
    loadMessages(conversationId)
  }

  const handleSendMessage = async (content: string) => {
    const userMessage: Message = {
      id: `msg_${Date.now()}_user`,
      role: 'user',
      content,
      timestamp: new Date()
    }

    const updatedMessages = [...messages, userMessage]
    setMessages(updatedMessages)
    saveMessages(activeConversationId, updatedMessages)

    setIsLoading(true)
    setIsStreaming(true)
    setConsigliereState('thinking')

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: content,
          conversationId: activeConversationId
        }),
      })

      if (response.status === 401) {
        router.push('/login')
        return
      }

      if (!response.ok) {
        throw new Error('Error al enviar mensaje')
      }

      const data = await response.json()

      // Adopta la conversación creada/confirmada por el servidor
      if (data.conversationId && data.conversationId !== activeConversationId) {
        setActiveConversationId(data.conversationId)
        localStorage.setItem('activeConversationId', data.conversationId)
      }

      setTimeout(() => {
        setIsStreaming(false)
        setConsigliereState('responding')

        // El route devuelve { response }, no { message }; el servidor no envía
        // timestamp → hora local del cliente
        const responseText: string = data.response ?? 'Sin respuesta'
        const assistantMessage: Message = {
          id: `msg_${Date.now()}_assistant`,
          role: 'assistant',
          content: responseText,
          timestamp: new Date()
        }

        const finalMessages = [...updatedMessages, assistantMessage]
        setMessages(finalMessages)
        saveMessages(data.conversationId ?? activeConversationId, finalMessages)

        const lower = responseText.toLowerCase()
        if (lower.includes('fuga')) {
          setTimeout(() => setConsigliereState('alert'), 1600)
          setTimeout(() => setConsigliereState('idle'), 2100)
        } else if (lower.includes('excelente') || lower.includes('¡')) {
          setTimeout(() => setConsigliereState('celebrate'), 1600)
          setTimeout(() => setConsigliereState('idle'), 3400)
        } else {
          setTimeout(() => setConsigliereState('idle'), 1600)
        }
      }, 1000)

    } catch (error) {
      console.error('Error sending message:', error)
      setIsStreaming(false)
      
      const errorMessage: Message = {
        id: `msg_${Date.now()}_error`,
        role: 'assistant',
        content: 'Lo siento, ha ocurrido un error. Por favor, intenta de nuevo.',
        timestamp: new Date()
      }
      
      const finalMessages = [...updatedMessages, errorMessage]
      setMessages(finalMessages)
      saveMessages(activeConversationId, finalMessages)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="flex h-screen bg-[#F9F9F9]">
      <ConversationSidebar
        conversations={conversations}
        activeId={activeConversationId}
        onSelect={handleSelectConversation}
        onNew={startNewConversation}
      />

      <div className="flex-1 flex flex-col">
        <div className="border-b border-[#E4DFD5] bg-white px-6 py-4">
          <div className="max-w-4xl mx-auto">
            <h1 className="text-2xl font-bold text-[#1A1A1A]">
              Consigliere CFO
            </h1>
            <p className="text-sm text-gray-600">
              Tu asesor financiero personal con autoridad y experiencia
            </p>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-8">
          <div className="max-w-4xl mx-auto">
            {messages.length === 0 ? (
              <div className="text-center py-16">
                <div className="inline-block w-20 h-20 rounded-full bg-gradient-to-br from-[#D9B648] to-[#C9A84C] flex items-center justify-center shadow-lg mb-6">
                  <span className="text-white text-2xl font-bold">CFO</span>
                </div>
                
                <h2 className="text-2xl font-bold text-[#1A1A1A] mb-3">
                  Bienvenido a tu Consigliere Financiero
                </h2>
                
                <p className="text-gray-600 mb-8 max-w-md mx-auto">
                  Soy tu asesor personal de dominio financiero. Pregúntame lo que necesites 
                  sobre tus finanzas, presupuesto, ahorro o inversiones.
                </p>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-2xl mx-auto">
                  <button
                    onClick={() => handleSendMessage('¿Cómo cierro el mes?')}
                    disabled={isLoading}
                    className="p-4 bg-white border-2 border-[#E4DFD5] rounded-lg hover:border-[#D9B648] transition-colors text-left"
                  >
                    <div className="text-2xl mb-2">📊</div>
                    <div className="font-semibold text-sm text-[#1A1A1A] mb-1">
                      Cierre mensual
                    </div>
                    <div className="text-xs text-gray-600">
                      Aprende a cerrar tu mes correctamente
                    </div>
                  </button>

                  <button
                    onClick={() => handleSendMessage('¿Dónde se va mi dinero?')}
                    disabled={isLoading}
                    className="p-4 bg-white border-2 border-[#E4DFD5] rounded-lg hover:border-[#D9B648] transition-colors text-left"
                  >
                    <div className="text-2xl mb-2">🔍</div>
                    <div className="font-semibold text-sm text-[#1A1A1A] mb-1">
                      Análisis de gastos
                    </div>
                    <div className="text-xs text-gray-600">
                      Descubre dónde va tu dinero
                    </div>
                  </button>

                  <button
                    onClick={() => handleSendMessage('¿Cuánto puedo ahorrar?')}
                    disabled={isLoading}
                    className="p-4 bg-white border-2 border-[#E4DFD5] rounded-lg hover:border-[#D9B648] transition-colors text-left"
                  >
                    <div className="text-2xl mb-2">💰</div>
                    <div className="font-semibold text-sm text-[#1A1A1A] mb-1">
                      Plan de ahorro
                    </div>
                    <div className="text-xs text-gray-600">
                      Calcula tu potencial de ahorro
                    </div>
                  </button>
                </div>
              </div>
            ) : (
              <>
                {messages.map((message, index) => (
                  <ChatMessage
                    key={message.id}
                    role={message.role}
                    content={message.content}
                    timestamp={message.timestamp}
                    consigliereState={message.role === 'assistant' && index === messages.length - 1 ? consigliereState : 'idle'}
                  />
                ))}
                
                {isStreaming && (
                  <ChatMessage
                    role="assistant"
                    content=""
                    timestamp={new Date()}
                    isStreaming={true}
                    consigliereState={consigliereState}
                  />
                )}
                
                <div ref={messagesEndRef} />
              </>
            )}
          </div>
        </div>

        <ChatInput
          onSend={handleSendMessage}
          disabled={isLoading}
          placeholder="Pregunta a tu Consigliere Financiero..."
        />
      </div>
    </div>
  )
}
