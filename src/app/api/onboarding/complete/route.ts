import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: 'No autenticado' },
        { status: 401 }
      )
    }

    const body = await request.json()
    const {
      financialFear,
      language,
      country,
      employmentType,
      monthlySalary,
      mainGoal,
      goalDate
    } = body

    if (!financialFear || !language || !country || !employmentType || !monthlySalary || !mainGoal || !goalDate) {
      return NextResponse.json(
        { error: 'Faltan campos requeridos' },
        { status: 400 }
      )
    }

    const validLanguages = ['es', 'pt', 'en', 'de', 'fr', 'sv']
    if (!validLanguages.includes(language)) {
      return NextResponse.json(
        { error: 'Idioma no válido' },
        { status: 400 }
      )
    }

    const sanitizedGoal = mainGoal.trim().substring(0, 500)
    const sanitizedFear = financialFear.trim().substring(0, 200)

    const { error: updateError } = await supabase
      .from('profiles')
      .update({
        onboarding_done: true,
        language: language,
        onboarding_data: {
          financial_fear: sanitizedFear,
          country: country,
          employment_type: employmentType,
          monthly_salary: monthlySalary,
          main_goal: sanitizedGoal,
          goal_date: goalDate,
          completed_at: new Date().toISOString()
        }
      })
      .eq('user_id', user.id)

    if (updateError) {
      console.error('Error updating profile:', updateError)
      return NextResponse.json(
        { error: 'Error al actualizar el perfil' },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error in onboarding completion:', error)
    return NextResponse.json(
      { error: 'Error interno del servidor' },
      { status: 500 }
    )
  }
}
