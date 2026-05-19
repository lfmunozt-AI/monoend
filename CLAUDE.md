# CLAUDE.md — andgcore · Sovereign CFO B2C
# Actualizado: 2026-05-19

## PROYECTO
Nombre: Sovereign CFO / andgcore  
Tipo: SaaS B2C · Copiloto de Independencia Financiera  
Stack: Next.js 16 · TypeScript · Tailwind · Supabase · Vercel · OpenAI  
Dominio: app.andgcore.com  

## AGENTE ACTIVO
<!-- Cambiar al inicio de cada sesión -->
Agente: [XX — Nombre]
Worktree: ../wt-agXX-nombre/
Tarea: [item del backlog]
Output esperado: [archivo específico]
No tocar: [scope de otros agentes]

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
- [x] Chat CFO con LLM real (gpt-4o-mini) ✓
- [x] API transacciones completa con RAG ✓
- [x] Embeddings + búsqueda semántica ✓
- [ ] Día 4: TransactionForm UI + Stripe
- [x] Dashboard con Consigliere ✓ (rediseño v3 en curso)
- [x] Dashboard definitivo v3 — paleta + dopamina + dark mode ✓
- [x] Contraste fondo #E8E3D9 vs cards #FFFFFF con sombra ✓
- [x] Dark mode funcional con toggle sidebar ✓
- [x] Modal fugas con advertencia + revertir 60s ✓
- [x] Logout en sidebar ✓
- [x] Nombre real usuario desde profiles.name ✓
- [ ] Motor IDF — idf.ts + idf-service.ts ← AG06 EN CURSO
- [ ] Prompts IDF actualizados ← AG08 EN CURSO
- [ ] Migración 007_goals_idf.sql ← pendiente ejecutar en Supabase
- [ ] Onboarding → solo GDPR + primera sesión Consigliere
- [ ] Memoria continua entre sesiones
- [ ] Proactividad del Consigliere

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

## DECISIONES TÉCNICAS — 2026-05-15

### ICA — única fuente de verdad via trigger
- El ICA solo se incrementa via trigger Supabase (`005_ica_trigger.sql`)
- Nunca calcular ni mutar ICA desde el código de aplicación
- Garantiza consistencia aunque múltiples agentes escriban transacciones

### chat/route.ts — versión AG08 es canónica
- `src/app/api/chat/route.ts` de AG08 (LLM real) prevalece sobre cualquier mock de AG04
- AG04 solo gestiona los componentes UI del chat; nunca reimplementar la lógica de ruta

### Embeddings — fire-and-forget
- El embedding de una transacción no bloquea el guardado si falla
- `src/lib/embeddings.ts` es owner; AG01 valida, otros agentes solo importan
- Migración `006_embeddings_search.sql` + función RPC `match_embeddings()` ejecutada en Supabase

### Rate limit chat — free tier
- Free = 20 queries/día contando mensajes con `role='user'` en UTC
- Lógica en `src/app/api/chat/route.ts`; no duplicar en cliente

### callLLMWithHistory — AG08
- Añadido a `src/lib/llm.ts` para mantener contexto conversacional
- Recibe array de mensajes; AG08 es owner, no modificar sin coordinación

## DECISIONES TÉCNICAS — 2026-05-19

### ICA e IDF son métricas independientes
- ICA sube solo cuando el usuario aporta información al sistema
- IDF sube cuando mejora el progreso hacia la meta
- No confundir: pueden moverse en sentidos opuestos en una misma sesión

### Dashboard — contraste y profundidad
- Fondo dashboard: `#E8E3D9` (más contraste que `#F4F1EA`)
- Cards con `box-shadow: 0 1px 4px rgba(0,0,0,.08)` para separación visual

### Herramientas por tipo de tarea
- Claude Code para código principal (lógica, servicios, APIs, tests)
- Windsurf para UI components < 100 líneas

## ARCHIVOS MODIFICADOS — 2026-05-15
AG08:
- `src/app/api/chat/route.ts`
- `src/app/api/chat/history/route.ts`
- `src/lib/llm.ts`

AG04:
- `src/components/chat/ChatMessage.tsx`
- `src/components/chat/ChatInput.tsx`
- `src/components/chat/ConversationSidebar.tsx`
- `src/app/(dashboard)/chat/page.tsx`

AG01:
- `src/lib/transactions-validation.ts`
- `src/lib/embeddings.ts`
- `src/app/api/transactions/route.ts`
- `src/app/api/transactions/[id]/route.ts`
- `src/lib/__tests__/transactions.test.ts`
- `supabase/migrations/006_embeddings_search.sql`

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

## PIVOT AAAS — LEER ANTES DE CUALQUIER TAREA
- The Consigliere = método principal INPUT/OUTPUT (no es chat de soporte)
- ICA = pequeño círculo "Lo que sé de ti" · muestra % · indicador interno
- IDF = protagonista · "Tu progreso hacia: [meta]" · 4 dimensiones (40/25/20/15)
- Onboarding = solo GDPR · resto via Consigliere en primera sesión
- Memoria financiera continua entre sesiones (RAG completo)
- Proactividad = el agente habla primero sin que le pregunten
- Animaciones Consigliere = CSS v1 · Lottie planificado Fase 2
- Modo oscuro = funcional con toggle en sidebar
- Open Banking = post-MVP · regulatorio

## PALETA DE COLORES — NO DESVIAR
Light: Background #E8E3D9 · Cards #FFFFFF · Secundario #F0EDE6
Dark: Background #0E0E0E · Cards #1A1A1A · Secundario #141414
Texto primario: #1A1A1A (light) / #EAE6DC (dark)
Texto secundario: #7A736C (light) / #6A6460 (dark)
Primario/acción: #C9A84C
Éxito: #2D6A4F (verde bosque)
Peligro/fugas: #8B2635 (burdeos)
Advertencia: #92570A (mostaza oscura)
Sidebar: #111111 siempre
PROHIBIDO: azules neón, verdes tóxicos

## TERMINOLOGÍA ANDGCORE
- "Reserva de Soberanía" = fondo de emergencia
- "Fuga de Poder" = gasto innecesario
- "Escudo Familiar" = seguros/protección
- "Escenario de Poder" = proyección what-if
- "Dominio Financiero" = nivel máximo (NO Soberanía)
- "The Consigliere" = nombre del agente (NO traducir)

## AAAS ROADMAP
L1 Reactivo (hoy) → L2 Proactivo (hoy) → 
L3 Autónomo (mes 6-12) → L4 Orquestador (año 2+)
Revenue: suscripción → % valor generado

## REGLAS ABSOLUTAS
1. SOLO features B2C
2. RLS activo en TODAS las tablas
3. Nunca almacenar IBANs ni credenciales bancarias
4. LLM: gpt-4o-mini · NO usar GPU local
5. Idioma código: inglés · UI default: español
6. NO usar palabra "Soberano/Soberanía" en UI
7. Plan en sidebar: "Élite · activo" + "Ver beneficios"

## IDF FÓRMULA
Progreso al objetivo: 40%
Control de fugas: 25%
Estabilidad base: 20%
Velocidad de ahorro: 15%

## PRIMERA SESIÓN CONSIGLIERE
Al completar GDPR → Consigliere inicia conversación con mensaje de bienvenida.
Extrae de la respuesta: meta principal, plazo, urgencia, miedo subyacente.
Todo se guarda estructurado en DB sin formulario.
