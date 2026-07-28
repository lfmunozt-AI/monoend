'use client'

import { useState, useEffect } from 'react'
import PactoModal from './PactoModal'

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

interface OnboardingWizardProps {
  onComplete: (data: OnboardingData) => void
}

const STEPS = [
  'Bienvenida',
  'Pacto de Datos',
  'Idioma',
  'Perfil Fiscal',
  'Meta Principal'
]

const LANGUAGES = [
  { code: 'es', name: 'Español', flag: '🇪🇸' },
  { code: 'pt', name: 'Português', flag: '🇵🇹' },
  { code: 'en', name: 'English', flag: '🇬🇧' },
  { code: 'de', name: 'Deutsch', flag: '🇩🇪' },
  { code: 'fr', name: 'Français', flag: '🇫🇷' },
  { code: 'sv', name: 'Svenska', flag: '🇸🇪' }
]

const COUNTRIES = [
  'Portugal',
  'España',
  'México',
  'Argentina',
  'Colombia',
  'Chile',
  'Perú',
  'Venezuela',
  'Ecuador',
  'Guatemala',
  'Cuba',
  'Bolivia',
  'República Dominicana',
  'Honduras',
  'Paraguay',
  'El Salvador',
  'Nicaragua',
  'Costa Rica',
  'Panamá',
  'Uruguay',
  'Otro'
]

const EMPLOYMENT_TYPES = [
  'Empleado por cuenta ajena',
  'Autónomo / Freelance',
  'Empresario / Emprendedor',
  'Desempleado',
  'Jubilado',
  'Estudiante'
]

const FINANCIAL_FEARS = [
  'No llegar a fin de mes',
  'Deudas crecientes',
  'No tener ahorros',
  'No poder retirarme',
  'Perder mi trabajo',
  'Otro'
]

export default function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const [currentStep, setCurrentStep] = useState(0)
  const [data, setData] = useState<OnboardingData>({
    financialFear: '',
    pactoAccepted: false,
    language: 'es',
    country: '',
    employmentType: '',
    monthlySalary: '',
    mainGoal: '',
    goalDate: ''
  })
  const [detectedLanguage, setDetectedLanguage] = useState<string>('es')
  const [isDetecting, setIsDetecting] = useState(false)
  const [otherFear, setOtherFear] = useState('')

  useEffect(() => {
    if (currentStep === 2) {
      detectLanguageByIP()
    }
  }, [currentStep])

  const detectLanguageByIP = async () => {
    setIsDetecting(true)
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 3000)
      
      const response = await fetch('https://ipapi.co/json/', {
        signal: controller.signal
      })
      clearTimeout(timeoutId)
      
      if (!response.ok) {
        throw new Error('Failed to fetch IP data')
      }
      
      const ipData = await response.json()
      
      const countryToLanguage: Record<string, string> = {
        'ES': 'es',
        'PT': 'pt',
        'GB': 'en',
        'US': 'en',
        'DE': 'de',
        'FR': 'fr',
        'SE': 'sv',
        'MX': 'es',
        'AR': 'es',
        'CO': 'es',
        'CL': 'es',
        'PE': 'es',
        'VE': 'es',
        'EC': 'es',
        'BR': 'pt'
      }
      
      const detected = countryToLanguage[ipData.country_code] || 'es'
      setDetectedLanguage(detected)
      setData(prev => ({ ...prev, language: detected }))
    } catch (error) {
      console.error('Error detecting language:', error)
      setDetectedLanguage('es')
    } finally {
      setIsDetecting(false)
    }
  }

  const handleNext = () => {
    if (currentStep < STEPS.length - 1) {
      setCurrentStep(currentStep + 1)
    } else {
      const finalData = {
        ...data,
        financialFear: data.financialFear === 'Otro' ? otherFear : data.financialFear
      }
      onComplete(finalData)
    }
  }

  const handleBack = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1)
    }
  }

  const canProceed = () => {
    switch (currentStep) {
      case 0:
        return data.financialFear !== '' && (data.financialFear !== 'Otro' || otherFear.trim() !== '')
      case 1:
        return data.pactoAccepted
      case 2:
        return data.language !== ''
      case 3:
        return data.country !== '' && data.employmentType !== '' && data.monthlySalary !== ''
      case 4:
        return data.mainGoal.trim() !== '' && data.goalDate !== ''
      default:
        return false
    }
  }

  const progressPercentage = ((currentStep + 1) / STEPS.length) * 100

  return (
    <div className="min-h-screen bg-[#F9F9F9] py-8 px-4">
      <div className="max-w-3xl mx-auto">
        <div className="mb-8">
          <div className="flex justify-between items-center mb-4">
            <h1 className="text-2xl font-bold text-[#1A1A1A]">
              Configuración Inicial
            </h1>
            <span className="text-sm text-gray-600">
              Paso {currentStep + 1} de {STEPS.length}
            </span>
          </div>
          
          <div className="w-full bg-[#E4DFD5] rounded-full h-3 overflow-hidden">
            <div
              className="bg-[#D9B648] h-full transition-all duration-500 ease-out"
              style={{ width: `${progressPercentage}%` }}
            />
          </div>
          
          <div className="flex justify-between mt-2">
            {STEPS.map((step, index) => (
              <span
                key={step}
                className={`text-xs ${
                  index <= currentStep ? 'text-[#D9B648] font-medium' : 'text-gray-400'
                }`}
              >
                {step}
              </span>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-lg shadow-lg p-8 min-h-[500px]">
          {currentStep === 0 && (
            <div className="space-y-6">
              <div className="text-center mb-8">
                <h2 className="text-3xl font-bold text-[#1A1A1A] mb-3">
                  ¡Bienvenido a Sovereign CFO!
                </h2>
                <p className="text-gray-600 text-lg">
                  Tu copiloto hacia la independencia financiera
                </p>
              </div>

              <div className="bg-[#F7EBA5] p-6 rounded-lg mb-6">
                <p className="text-[#1A1A1A] text-center font-medium">
                  Vamos a conocerte mejor para personalizar tu experiencia
                </p>
              </div>

              <div>
                <label className="block text-lg font-semibold text-[#1A1A1A] mb-4">
                  ¿Cuál es tu mayor miedo financiero?
                </label>
                <div className="space-y-3">
                  {FINANCIAL_FEARS.map((fear) => (
                    <button
                      key={fear}
                      onClick={() => setData({ ...data, financialFear: fear })}
                      className={`w-full text-left px-6 py-4 rounded-lg border-2 transition-all ${
                        data.financialFear === fear
                          ? 'border-[#D9B648] bg-[#F7EBA5]'
                          : 'border-[#E4DFD5] hover:border-[#D9B648]/50'
                      }`}
                    >
                      <span className="text-[#1A1A1A] font-medium">{fear}</span>
                    </button>
                  ))}
                </div>

                {data.financialFear === 'Otro' && (
                  <input
                    type="text"
                    value={otherFear}
                    onChange={(e) => setOtherFear(e.target.value)}
                    placeholder="Describe tu mayor miedo financiero..."
                    className="mt-4 w-full px-4 py-3 border-2 border-[#E4DFD5] rounded-lg focus:border-[#D9B648] focus:outline-none"
                  />
                )}
              </div>
            </div>
          )}

          {currentStep === 1 && (
            <PactoModal
              onAccept={async () => {
                try {
                  const res = await fetch('/api/gdpr/consent', { method: 'POST' })
                  if (!res.ok) throw new Error()
                } catch {
                  alert('Error al registrar el consentimiento. Intenta de nuevo.')
                  return
                }
                setData({ ...data, pactoAccepted: true })
                handleNext()
              }}
              onReject={() => {
                alert('Para usar Sovereign CFO, necesitamos que aceptes nuestro Pacto de Datos.')
              }}
            />
          )}

          {currentStep === 2 && (
            <div className="space-y-6">
              <div className="text-center mb-8">
                <h2 className="text-2xl font-bold text-[#1A1A1A] mb-3">
                  Selecciona tu idioma
                </h2>
                <p className="text-gray-600">
                  {isDetecting ? 'Detectando tu ubicación...' : 'Hemos detectado tu preferencia'}
                </p>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                {LANGUAGES.map((lang) => (
                  <button
                    key={lang.code}
                    onClick={() => setData({ ...data, language: lang.code })}
                    disabled={isDetecting}
                    className={`p-6 rounded-lg border-2 transition-all ${
                      data.language === lang.code
                        ? 'border-[#D9B648] bg-[#F7EBA5]'
                        : 'border-[#E4DFD5] hover:border-[#D9B648]/50'
                    } ${isDetecting ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    <div className="text-4xl mb-2">{lang.flag}</div>
                    <div className="text-[#1A1A1A] font-medium">{lang.name}</div>
                    {data.language === lang.code && lang.code === detectedLanguage && (
                      <div className="text-xs text-[#D9B648] mt-1">Detectado</div>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {currentStep === 3 && (
            <div className="space-y-6">
              <div className="text-center mb-8">
                <h2 className="text-2xl font-bold text-[#1A1A1A] mb-3">
                  Perfil Fiscal Básico
                </h2>
                <p className="text-gray-600">
                  Esto nos ayuda a personalizar tus recomendaciones
                </p>
              </div>

              <div>
                <label className="block text-sm font-semibold text-[#1A1A1A] mb-2">
                  País de residencia fiscal
                </label>
                <select
                  value={data.country}
                  onChange={(e) => setData({ ...data, country: e.target.value })}
                  className="w-full px-4 py-3 border-2 border-[#E4DFD5] rounded-lg focus:border-[#D9B648] focus:outline-none"
                >
                  <option value="">Selecciona tu país</option>
                  {COUNTRIES.map((country) => (
                    <option key={country} value={country}>
                      {country}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-semibold text-[#1A1A1A] mb-2">
                  Tipo de empleo
                </label>
                <select
                  value={data.employmentType}
                  onChange={(e) => setData({ ...data, employmentType: e.target.value })}
                  className="w-full px-4 py-3 border-2 border-[#E4DFD5] rounded-lg focus:border-[#D9B648] focus:outline-none"
                >
                  <option value="">Selecciona tu situación</option>
                  {EMPLOYMENT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-semibold text-[#1A1A1A] mb-2">
                  Salario mensual bruto aproximado (€)
                </label>
                <input
                  type="number"
                  value={data.monthlySalary}
                  onChange={(e) => setData({ ...data, monthlySalary: e.target.value })}
                  placeholder="Ej: 2500"
                  min="0"
                  step="100"
                  className="w-full px-4 py-3 border-2 border-[#E4DFD5] rounded-lg focus:border-[#D9B648] focus:outline-none"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Esta información es confidencial y solo se usa para personalizar tu experiencia
                </p>
              </div>
            </div>
          )}

          {currentStep === 4 && (
            <div className="space-y-6">
              <div className="text-center mb-8">
                <h2 className="text-2xl font-bold text-[#1A1A1A] mb-3">
                  Tu Primera Meta de Soberanía
                </h2>
                <p className="text-gray-600">
                  Define tu primer objetivo financiero
                </p>
              </div>

              <div className="bg-[#F7EBA5] p-6 rounded-lg mb-6">
                <p className="text-[#1A1A1A] text-sm">
                  <strong>Ejemplos:</strong> "Ahorrar 6 meses de gastos", "Eliminar deuda de tarjeta", 
                  "Crear fondo de emergencia de 5.000€", "Invertir mi primer 1.000€"
                </p>
              </div>

              <div>
                <label className="block text-sm font-semibold text-[#1A1A1A] mb-2">
                  ¿Cuál es tu primer objetivo de dominio?
                </label>
                <textarea
                  value={data.mainGoal}
                  onChange={(e) => setData({ ...data, mainGoal: e.target.value })}
                  placeholder="Describe tu objetivo principal..."
                  rows={4}
                  className="w-full px-4 py-3 border-2 border-[#E4DFD5] rounded-lg focus:border-[#D9B648] focus:outline-none resize-none"
                />
              </div>

              <div>
                <label className="block text-sm font-semibold text-[#1A1A1A] mb-2">
                  Fecha objetivo
                </label>
                <input
                  type="date"
                  value={data.goalDate}
                  onChange={(e) => setData({ ...data, goalDate: e.target.value })}
                  min={new Date().toISOString().split('T')[0]}
                  className="w-full px-4 py-3 border-2 border-[#E4DFD5] rounded-lg focus:border-[#D9B648] focus:outline-none"
                />
              </div>

              <div className="bg-[#F0EDE6] p-4 rounded-lg">
                <p className="text-sm text-gray-700">
                  💡 <strong>Consejo:</strong> Las metas específicas y con fecha límite tienen 
                  un 42% más de probabilidad de cumplirse.
                </p>
              </div>
            </div>
          )}
        </div>

        {currentStep !== 1 && (
          <div className="flex gap-4 mt-6">
            <button
              onClick={handleBack}
              disabled={currentStep === 0}
              className="px-6 py-3 border-2 border-[#E4DFD5] text-[#1A1A1A] rounded-lg font-medium hover:bg-[#F0EDE6] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Atrás
            </button>
            <button
              onClick={handleNext}
              disabled={!canProceed()}
              className="flex-1 px-6 py-3 bg-[#D9B648] text-[#1A1A1A] rounded-lg font-medium hover:bg-[#D9B648]/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {currentStep === STEPS.length - 1 ? 'Completar' : 'Siguiente'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
