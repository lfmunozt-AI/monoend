# CLAUDE.md — andgcore · Sovereign CFO B2C
# Actualizado: 2026-05-14 (rev2)

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
- "Dominio Total" = independencia financiera (reemplaza "Soberanía Total" en UI desde 2026-05-14)

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
- [x] 1.7 Dashboard ICA skeleton ✓
- [x] Sistema de prompts CFO completo ✓
- [x] ICA service integrado con Supabase ✓
- [x] Fix bugs dashboard + register + onboarding ✓
- [ ] Chat CFO conectado al LLM

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

## BUGFIXES — 2026-05-14 (AG01)

### BUG 1 — Dashboard error al cargar datos
- Archivo: `src/app/api/ica/score/route.ts`
- Causa: consulta SQL incorrecta a Supabase
- Fix: query corregido por AG01

### BUG 2 — Register redirigía al login
- Causa: `router.push('/login?message=check-email')` incorrecto tras registro
- Fix: cambiado a `router.push('/dashboard')`

### BUG 3 — Onboarding consent fallaba en BD
- Causa: tabla `consent_records` no existía — migración `003_gdpr.sql` no había sido ejecutada en Supabase
- Fix: migración ejecutada + `GRANT authenticated` aplicado
- Tablas creadas: `consent_records` y columna `deletion_scheduled_at` en `profiles`

## DECISIONES TÉCNICAS — 2026-05-14

### "Dominio Total" reemplaza "Soberanía Total" en UI
- Término actualizado en toda la UI a partir de hoy
- `ICA` (Índice de Control Autónomo) mantiene el nombre técnico internamente
- Actualizar cualquier string "Soberanía Total" que aparezca en componentes nuevos

### llm.ts — patrón dual de llamadas al LLM
- `callLLMJson<T>()` para parsing estructurado; usa `temperature: 0.2` — respuestas deterministas
- `callLLM()` con fallback sin `throw` para resiliencia — nunca bloquea el flujo del usuario
- Ambas funciones en `src/lib/llm.ts`; AG08 es owner, otros agentes solo consumen

### Sistema de prompts CFO — AG08
- Prompts en `src/lib/prompts/`: `consigliere`, `categorizar`, `detectarFuga`, `reporte`, `onboarding`
- Cada prompt es una función pura que recibe contexto y devuelve string
- No acoplar lógica de negocio dentro de los prompts

### Protocolo de migraciones SQL
- Las migraciones deben ejecutarse en Supabase **inmediatamente** después de ser generadas por los agentes
- Verificar que todas las tablas existen antes de hacer push a producción
- Responsable de ejecución: AG01 (validación) o quien haga el merge final
- Referencia: BUG 3 — `003_gdpr.sql` generada por AG04 pero no ejecutada hasta hoy

### ICA trigger — migración 005
- `supabase/migrations/005_ica_trigger.sql` — trigger automático en Supabase al insertar/actualizar datos relevantes
- `src/lib/ica-service.ts` es la capa de servicio entre la BD y el cálculo ICA

## ARCHIVOS MODIFICADOS — 2026-05-14
AG04:
- `src/components/dashboard/IcaCircle.tsx`
- `src/components/dashboard/MetricCard.tsx`
- `src/components/dashboard/PowerLeakBadge.tsx`
- `src/app/(dashboard)/dashboard/page.tsx`
- `src/app/api/ica/score/route.ts`

AG06:
- `src/lib/ica-service.ts`
- `src/app/api/ica/score/route.ts`
- `supabase/migrations/005_ica_trigger.sql`

AG08:
- `src/lib/prompts/consigliere.ts`
- `src/lib/prompts/categorizar.ts`
- `src/lib/prompts/detectarFuga.ts`
- `src/lib/prompts/reporte.ts`
- `src/lib/prompts/onboarding.ts`
- `src/lib/llm.ts`

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
