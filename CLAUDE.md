# CLAUDE.md — andgcore · Sovereign CFO B2C
# Actualizado: 2026-05-13

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
- [x] 1.1 Repo + Next.js setup ✓
- [x] 1.2 Schema Supabase + RLS ✓
- [x] 1.3 Vercel pipeline funcionando ✓
- [ ] 1.4 app.andgcore.com → apuntar dominio DNS
- [x] 1.5 Auth email + Google OAuth ✓
- [x] 1.6 Onboarding + Quiz + GDPR ✓
- [x] Lógica fiscal Portugal ✓
- [x] Algoritmo ICA completo ✓
- [x] GDPR Pacto de Datos ✓
- [ ] 1.7 Dashboard ICA skeleton

## DECISIONES TÉCNICAS — 2026-05-13

### PactoModal — dos versiones coexisten
- `src/components/PactoModal.tsx` — creado por AG10, standalone, huérfano (nada lo importa aún)
- `src/components/onboarding/PactoModal.tsx` — creado por AG04, embebido en OnboardingWizard
- Fix aplicado: AG04 no registraba consent en BD; se añadió POST a `/api/gdpr/consent` en `onAccept`
- Pendiente: integrar PactoModal AG10 en flujos que lo necesiten o eliminar el duplicado

### projections.ts — cobertura fiscal
- Portugal soportado con lógica completa (`src/lib/fiscal/portugal.ts`)
- Otros países: fallback al 75% (estimación conservadora)
- Documentar para AG06 antes de implementar nuevos países

### middleware.ts — deprecación Next.js 16
- `src/middleware.ts` genera warning de deprecación en Next.js 16
- Pendiente renombrar a `proxy.ts` — asignado a AG03
- Protección de rutas `(dashboard)` depende de este middleware; no tocar hasta renombrar

### onboarding_data — migración BD
- Migración `supabase/migrations/004_onboarding_data.sql` añade columna `onboarding_data jsonb` a `profiles`
- Esta columna no existía en `001_initial_schema.sql`; fix crítico aplicado en validación AG10

### Bugfix crítico route onboarding/complete
- `src/app/api/onboarding/complete/route.ts:61` — corregido `.eq('id', user.id)` → `.eq('user_id', user.id)`
- Tabla `profiles` tiene PK propia (`id`) distinta del UUID de auth; siempre usar `user_id` para lookups por usuario

## ARCHIVOS MODIFICADOS — 2026-05-13
- `src/lib/gdpr.ts`
- `src/lib/fiscal/portugal.ts`
- `src/lib/ica.ts`
- `src/lib/projections.ts`
- `src/lib/__tests__/portugal.test.ts`
- `src/lib/__tests__/ica.test.ts`
- `src/components/PactoModal.tsx`
- `src/components/onboarding/OnboardingWizard.tsx`
- `src/app/(dashboard)/onboarding/page.tsx`
- `src/app/api/gdpr/consent/route.ts`
- `src/app/api/gdpr/delete/route.ts`
- `src/app/api/gdpr/export/route.ts`
- `src/app/api/onboarding/complete/route.ts`
- `src/app/privacy/page.tsx`
- `supabase/migrations/003_gdpr.sql`
- `supabase/migrations/004_onboarding_data.sql`
