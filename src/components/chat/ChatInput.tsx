'use client'

import { useState, useRef, KeyboardEvent, useCallback } from 'react'

interface ChatInputProps {
  onSend: (message: string) => void
  disabled?: boolean
  placeholder?: string
}

const QUICK_SUGGESTIONS = [
  '¿Cómo cierro el mes?',
  '¿Dónde se va mi dinero?',
  '¿Cuánto puedo ahorrar?'
]

const MAX_CHARS = 500

export default function ChatInput({ 
  onSend, 
  disabled = false, 
  placeholder = 'Pregunta a tu Consigliere Financiero...' 
}: ChatInputProps) {
  const [message, setMessage] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleSend = useCallback(() => {
    const trimmed = message.trim()
    if (trimmed && !disabled) {
      onSend(trimmed)
      setMessage('')
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
      }
    }
  }, [message, disabled, onSend])

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    if (value.length <= MAX_CHARS) {
      setMessage(value)
      
      e.target.style.height = 'auto'
      e.target.style.height = `${Math.min(e.target.scrollHeight, 150)}px`
    }
  }, [])

  const handleSuggestionClick = useCallback((suggestion: string) => {
    if (!disabled) {
      onSend(suggestion)
    }
  }, [disabled, onSend])

  const charCount = message.length
  const isOverLimit = charCount > MAX_CHARS
  const isNearLimit = charCount > MAX_CHARS * 0.8

  return (
    <div className="border-t border-[#E4DFD5] bg-white p-4">
      <div className="max-w-4xl mx-auto">
        <div className="flex gap-3 mb-3">
          {QUICK_SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              onClick={() => handleSuggestionClick(suggestion)}
              disabled={disabled}
              className="px-3 py-1.5 text-xs border border-[#E4DFD5] rounded-full text-gray-700 hover:border-[#D9B648] hover:text-[#D9B648] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {suggestion}
            </button>
          ))}
        </div>

        <div className="relative">
          <textarea
            ref={textareaRef}
            value={message}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            rows={1}
            className="w-full px-4 py-3 pr-24 border-2 border-[#E4DFD5] rounded-lg focus:border-[#D9B648] focus:outline-none resize-none disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ minHeight: '48px', maxHeight: '150px' }}
          />
          
          <div className="absolute right-2 bottom-2 flex items-center gap-2">
            <span 
              className={`text-xs ${
                isOverLimit ? 'text-[#E85C5C]' : isNearLimit ? 'text-[#E8A93C]' : 'text-gray-400'
              }`}
            >
              {charCount}/{MAX_CHARS}
            </span>
            
            <button
              onClick={handleSend}
              disabled={disabled || !message.trim() || isOverLimit}
              className="px-4 py-2 bg-[#D9B648] text-[#1A1A1A] rounded-lg font-medium hover:bg-[#D9B648]/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Enviar
            </button>
          </div>
        </div>

        <p className="text-xs text-gray-500 mt-2">
          <kbd className="px-1.5 py-0.5 bg-gray-100 border border-gray-300 rounded text-xs">Enter</kbd> para enviar · 
          <kbd className="px-1.5 py-0.5 bg-gray-100 border border-gray-300 rounded text-xs ml-1">Shift + Enter</kbd> para nueva línea
        </p>
      </div>
    </div>
  )
}
