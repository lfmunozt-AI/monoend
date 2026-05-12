import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import LogoutButton from '@/components/LogoutButton'

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  return (
    <div className="min-h-screen bg-[#F9F9F9]">
      <div className="container mx-auto px-4 py-8">
        <div className="bg-white rounded-lg shadow-lg p-8">
          <div className="flex justify-between items-center mb-8">
            <div>
              <h1 className="text-3xl font-bold text-[#1A1A1A] mb-2">
                Dashboard
              </h1>
              <p className="text-gray-600">
                Bienvenido a tu Sovereign CFO
              </p>
            </div>
            <LogoutButton />
          </div>

          <div className="bg-gray-50 rounded-lg p-6">
            <h2 className="text-xl font-semibold text-[#1A1A1A] mb-4">
              Información de Usuario
            </h2>
            <div className="space-y-2">
              <p className="text-gray-700">
                <span className="font-medium">Email:</span> {user.email}
              </p>
              <p className="text-gray-700">
                <span className="font-medium">ID:</span> {user.id}
              </p>
              <p className="text-gray-700">
                <span className="font-medium">Último inicio:</span> {user.last_sign_in_at ? new Date(user.last_sign_in_at).toLocaleDateString('es-ES') : 'N/A'}
              </p>
            </div>
          </div>

          <div className="mt-8">
            <h2 className="text-xl font-semibold text-[#1A1A1A] mb-4">
              Tu Camino hacia la Soberanía Financiera
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="bg-gray-50 rounded-lg p-6">
                <h3 className="font-semibold text-[#D9B648] mb-2">
                  Reserva de Soberanía
                </h3>
                <p className="text-gray-600 text-sm">
                  Tu fondo de emergencia para la tranquilidad
                </p>
              </div>
              <div className="bg-gray-50 rounded-lg p-6">
                <h3 className="font-semibold text-[#D9B648] mb-2">
                  Fuga de Poder
                </h3>
                <p className="text-gray-600 text-sm">
                  Identifica y elimina gastos innecesarios
                </p>
              </div>
              <div className="bg-gray-50 rounded-lg p-6">
                <h3 className="font-semibold text-[#D9B648] mb-2">
                  Escenario de Poder
                </h3>
                <p className="text-gray-600 text-sm">
                  Proyecciones what-if para tu futuro
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
