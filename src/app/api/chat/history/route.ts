import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'

const HISTORY_LIMIT = 20

interface ConversationRow {
  id: string
  title: string | null
  created_at: string
  updated_at: string
}

interface MessageRow {
  role: string
  content: string
  created_at: string
}

export async function GET() {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 })
  }

  const admin = adminClient()

  // ── Conversaciones ordenadas por actividad ───────────────────────────────────
  const { data: conversations, error } = await admin
    .from('conversations')
    .select('id, title, created_at, updated_at')
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false })
    .limit(HISTORY_LIMIT)

  if (error) {
    console.error('[chat/history] conversaciones:', error)
    return NextResponse.json({ error: 'Error al obtener el historial' }, { status: 500 })
  }

  if (!conversations || conversations.length === 0) {
    return NextResponse.json({ conversations: [] })
  }

  // ── Último mensaje por conversación (parallel) ───────────────────────────────
  const withLastMessage = await Promise.all(
    (conversations as ConversationRow[]).map(async (conv) => {
      const { data: lastMsg } = await admin
        .from('messages')
        .select('role, content, created_at')
        .eq('conversation_id', conv.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      return {
        id: conv.id,
        title: conv.title,
        createdAt: conv.created_at,
        updatedAt: conv.updated_at,
        lastMessage: lastMsg
          ? {
              role: (lastMsg as MessageRow).role,
              content: (lastMsg as MessageRow).content,
              createdAt: (lastMsg as MessageRow).created_at,
            }
          : null,
      }
    })
  )

  return NextResponse.json(
    { conversations: withLastMessage },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
