# CLAUDE.md — andgcore · Sovereign CFO B2C
# Actualizado: [fecha]

## PROYECTO
Nombre: Sovereign CFO / andgcore  
Tipo: SaaS B2C · Copiloto de Independencia Financiera  
Stack: Next.js 16 · TypeScript · Tailwind · Supabase · Vercel · OpenAI  
Dominio: app.andgcore.com  

## REGLAS ABSOLUTAS
1. SOLO features B2C — nunca añadir lógica B2B/empresa
2. RLS activo en TODAS las tablas Supabase
3. Nunca almacenar IBANs ni credenciales bancarias
4. LLM actual: gpt-4o-mini (OpenAI) — NO usar GPU local todavía
5. Idioma del código: inglés · UI default: español

## AGENTE ACTIVO
<!-- Cambiar al inicio de cada sesión -->
Agente: [XX — Nombre]
Worktree: ../wt-agXX-nombre/
Tarea: [item del backlog]
Output esperado: [archivo específico]
No tocar: [scope de otros agentes]

## TERMINOLOGÍA ANDGCORE
- "Reserva de Soberanía" = fondo de emergencia
- "Fuga de Poder" = gasto innecesario
- "Escudo Familiar" = seguros/protección  
- "Escenario de Poder" = proyección what-if
- "Soberanía Total" = independencia financiera

## ESTADO DEL BACKLOG
- [ ] 1.1 Repo + Next.js setup ← EN CURSO
- [ ] 1.2 Schema Supabase + RLS
- [ ] 1.3 Auth email + Google OAuth
- [ ] 1.4 Onboarding + Quiz + GDPR
- [ ] 1.5 Dashboard ICA skeleton
