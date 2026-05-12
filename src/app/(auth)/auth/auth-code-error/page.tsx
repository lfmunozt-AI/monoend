import Link from 'next/link'

export default function AuthCodeErrorPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F9F9F9]">
      <div className="bg-white rounded-lg shadow-lg p-8 max-w-md w-full">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-red-600 mb-4">
            Error de Autenticación
          </h1>
          <p className="text-gray-600 mb-6">
            Hubo un problema al verificar tu cuenta. Por favor, intenta iniciar sesión nuevamente.
          </p>
          <Link
            href="/login"
            className="inline-block bg-[#D9B648] text-white py-2 px-6 rounded-md hover:bg-[#C4A542] transition-colors"
          >
            Volver al Login
          </Link>
        </div>
      </div>
    </div>
  )
}
