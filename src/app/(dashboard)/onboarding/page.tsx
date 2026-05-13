'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import OnboardingWizard from '@/components/onboarding/OnboardingWizard'

interface OnboardingData {
  financialFear: string
  pactoAccepted: boolean
  language: string
  country: string
  employmentType: string
  monthlySalary: string
  mainGoal: string
  goalDate: string
}

export default function OnboardingPage() {
  const router = useRouter()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleComplete = async (data: OnboardingData) => {
    setIsSubmitting(true)
    setError(null)

    try {
      const response = await fetch('/api/onboarding/complete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Error al completar el onboarding')
      }

      router.push('/dashboard')
      router.refresh()
    } catch (err) {
      console.error('Error completing onboarding:', err)
      setError(err instanceof Error ? err.message : 'Error desconocido')
      setIsSubmitting(false)
    }
  }

  if (isSubmitting) {
    return (
      <div className="min-h-screen bg-[#F9F9F9] flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-16 w-16 border-4 border-[#E4DFD5] border-t-[#D9B648] mb-4"></div>
          <p className="text-[#1A1A1A] text-lg font-medium">
            Configurando tu experiencia...
          </p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-[#F9F9F9] flex items-center justify-center p-4">
        <div className="bg-white rounded-lg shadow-lg p-8 max-w-md w-full">
          <div className="text-center">
            <div className="text-6xl mb-4">⚠️</div>
            <h2 className="text-2xl font-bold text-[#1A1A1A] mb-3">
              Error
            </h2>
            <p className="text-gray-600 mb-6">{error}</p>
            <button
              onClick={() => {
                setError(null)
                setIsSubmitting(false)
              }}
              className="px-6 py-3 bg-[#D9B648] text-[#1A1A1A] rounded-lg font-medium hover:bg-[#D9B648]/90 transition-colors"
            >
              Reintentar
            </button>
          </div>
        </div>
      </div>
    )
  }

  return <OnboardingWizard onComplete={handleComplete} />
}
