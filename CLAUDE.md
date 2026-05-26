# CLAUDE.md — AndgCore Technology
# Actualizado: 2026-05-26 (post-pivot blueprint)

## EMPRESA
AndgCore Technology — pre-incorporación, sede planificada Iberia (PT+ES).
Founder solo: Luis Muñoz. Capital propio, runway ~6 meses, buscando ronda.

## TRES PRODUCTOS BAJO ANDGCORE
1. **Producto B2C (Fase 1, actual)** — agente IA de finanzas personales.
   Nombre comercial: PENDIENTE DE VALIDACIÓN EUIPO.
   Working name interno: Sovereign CFO. Dominio operativo previsto: app.andgcore.com.
2. **Producto B2B (Fase 2)** — ~2 años post Fase 1 live. No tocar todavía.
3. **Producto wellness biométrico (Fase 3)** — ~3 años post Fase 2 live. No tocar.

## TERMINOLOGÍA OFICIAL
- **MVP** (no MIP, no MLP).
- **IDF — Índice de Dominio Financiero**: métrica protagonista de progreso hacia
  la meta declarada por el usuario.
- **ICA — Índice de Conocimiento del Asistido**: métrica secundaria de qué tanto
  el sistema conoce al usuario. (Reemplaza el viejo "Índice de Control Autónomo".)
- **The Consigliere**: agente IA. NUNCA traducir.
- **Fuga de Poder**: gasto innecesario / impulsivo.
- **Reserva de Soberanía**: fondo de emergencia.
- **Escudo Familiar**: seguros / protección patrimonial.
- **Escenario de Poder**: proyección what-if.
- **Hito**: milestone del IDF (alcanzar 25%, 50%, 75%, 100%).
- **Dominio Financiero**: nivel máximo (NO usar "Soberanía Total").

## FÓRMULA IDF (resumen)
```
IDF = 0.40 × ProgresoMeta
    + 0.25 × ControlFugas
    + 0.20 × EstabilidadBase
    + 0.15 × VelocidadAhorro
```
Niveles: Bronce (0-25) · Plata (26-50) · Oro (51-75) · Diamante (76-100).
Detalle matemático completo en `FORMULAS_IDF_ICA.md` (raíz del proyecto).

## FÓRMULA ICA (resumen)
```
ICA = 0.25 × PerfilCompleto
    + 0.25 × ProfundidadHistorica
    + 0.20 × DiversidadFuentes
    + 0.15 × Consistencia
    + 0.15 × Engagement
```
Niveles narrativos: 0-30 / 31-60 / 61-85 / 86-100.
Detalle matemático completo en `FORMULAS_IDF_ICA.md`.

> IDF e ICA son métricas **independientes**. Pueden moverse en sentidos opuestos
> en una misma sesión. El ICA solo se incrementa vía trigger Supabase
> (`005_ica_trigger.sql`); nunca mutarlo desde código de aplicación.

## STACK
- **Frontend**: Next.js 16 (App Router) · TypeScript · Tailwind CSS.
- **Backend/DB**: Supabase (PostgreSQL · RLS · pgvector · Auth).
- **Deployment**: Vercel · PRD desde `main` · QA desde `develop`.
- **LLM**: OpenAI gpt-4o-mini vía LLM Router (`src/lib/llm/router.ts`).

## DECISIÓN LLM
Patrón Router desde día 1. gpt-4o-mini hoy. Mistral / Together AI / modelo propio
como opciones futuras sin reescribir consumidores.
**NO hostear LLM propio antes de cerrar ronda o llegar a >10k DAU.**

Sub-patrones en `src/lib/llm.ts` (a migrar a `src/lib/llm/router.ts`):
- `callLLMJson<T>()` → parsing estructurado, `temperature: 0.2`.
- `callLLM()` → fallback sin throw, nunca bloquea al usuario.
- `callLLMWithHistory()` → contexto conversacional.
Owner: AG08. Otros agentes solo consumen.

## REGLAS ABSOLUTAS
1. Solo features **B2C** en esta fase. No tocar lógica B2B ni wellness.
2. **RLS activa** en TODAS las tablas Supabase.
3. **Nunca** almacenar IBANs, credenciales bancarias, NIFs / NIEs.
4. The Consigliere **nunca** recomienda producto financiero específico sin
   disclaimer (validador en `src/lib/llm/output-validator.ts`).
5. **Idioma del código: inglés. UI default: español.**
6. CSS animations v1; **Lottie en Fase 2**.
7. NO usar la palabra "Soberano/Soberanía" en UI (sí como término técnico
   acuñado: "Reserva de Soberanía").
8. LLM: gpt-4o-mini vía router · NO usar GPU local.
9. Plan en sidebar: "Élite · activo" + "Ver beneficios".

## PALETA DE COLORES — NO DESVIAR
| Token            | Light      | Dark       |
|------------------|------------|------------|
| Background       | `#E8E3D9`  | `#0E0E0E`  |
| Cards            | `#FFFFFF`  | `#1A1A1A`  |
| Secundario       | `#F0EDE6`  | `#141414`  |
| Texto primario   | `#1A1A1A`  | `#EAE6DC`  |
| Texto secundario | `#7A736C`  | `#6A6460`  |

Acción/primario: `#C9A84C` · Éxito: `#2D6A4F` (verde bosque) ·
Peligro/fugas: `#8B2635` (burdeos) · Advertencia: `#92570A` (mostaza oscura).
Sidebar: `#111111` siempre. Cards con `box-shadow: 0 1px 4px rgba(0,0,0,.08)`.
**Prohibido**: azules neón, verdes tóxicos.

## ESTRUCTURA DE WORKTREES (10 agentes)
Cada agente trabaja en `wt-agXX-<dominio>/` sobre su rama `agent/XX`.
Flujo: `agent/XX → develop → main` (merges los aprueba Luis).

| Agente | Worktree                | Dominio                                              |
|--------|-------------------------|------------------------------------------------------|
| AG01   | wt-ag01-arquitecto      | Arquitectura, validación, transacciones, embeddings  |
| AG02   | wt-ag02-datos           | Schema Supabase, migraciones, modelos de datos       |
| AG03   | wt-ag03-security        | Middleware, auth, RLS, renombre a `proxy.ts`         |
| AG04   | wt-ag04-ux              | Componentes UI, dashboard, chat UI, onboarding       |
| AG05   | wt-ag05-docs            | CLAUDE.md, AGENTS.md, PROJECT_LOG.md, INFORME.md     |
| AG06   | wt-ag06-finops          | Fiscal, proyecciones, ICA service, IDF service       |
| AG07   | wt-ag07-testing         | Tests unitarios e integración                        |
| AG08   | wt-ag08-consigliere     | LLM router, prompts, chat route, RAG                 |
| AG09   | wt-ag09-dopamina        | Gamificación, modal fugas, micro-feedback            |
| AG10   | wt-ag10-shield          | GDPR, privacy, Pacto de Datos, export/delete         |

Proceso obligatorio por agente (ver `PROJECT_LOG.md`):
1. `git branch` → verificar `agent/XX`.
2. `git fetch origin && git reset --hard origin/main`.
3. Leer `PROJECT_LOG.md` y `CLAUDE.md`.
4. Trabajar solo en archivos de su dominio.
5. `git push origin agent/XX` ÚNICAMENTE. PROHIBIDO push a main/develop o
   ramas de otros agentes.
6. Reportar Fase 4 y esperar aprobación de Luis.

## INFRAESTRUCTURA — VERCEL
- PRD: `sovereign-cfo.vercel.app` (rama `main`).
- QA: URL preview automática (rama `develop`).
- Ignored Build Step activo: solo `main` y `develop` generan deployments.
- Branch protection: control manual (GitHub Free no soporta en repos privados;
  activar cuando haya ingresos).

## PIVOT AAAS — LEER ANTES DE CUALQUIER TAREA
- **The Consigliere** = método principal INPUT/OUTPUT (no es chat de soporte).
- **ICA** = pequeño círculo "Lo que sé de ti" · indicador interno.
- **IDF** = protagonista · "Tu progreso hacia: [meta]" · 4 dimensiones.
- **Onboarding** = solo GDPR + primera sesión Consigliere (sin formularios).
- **Memoria financiera continua** entre sesiones (RAG completo).
- **Proactividad** = el agente habla primero sin que le pregunten.
- **Open Banking** = post-MVP (regulatorio).

## ROADMAP AAAS
L1 Reactivo (hoy) → L2 Proactivo (hoy) → L3 Autónomo (mes 6-12)
→ L4 Orquestador (año 2+). Revenue: suscripción → % valor generado.

## DECISIONES TÉCNICAS VIGENTES
- **PactoModal — dos versiones coexisten**.
  `src/components/PactoModal.tsx` (AG10, standalone, huérfano).
  `src/components/onboarding/PactoModal.tsx` (AG04, embebido en wizard, registra
  consent vía `/api/gdpr/consent`). Pendiente: integrar el de AG10 o eliminar.
- **`projections.ts`** — Portugal con lógica completa
  (`src/lib/fiscal/portugal.ts`). Otros países: fallback al 75%.
- **`middleware.ts`** — deprecado en Next.js 16. Pendiente renombrar a
  `proxy.ts` (asignado a AG03). Protege rutas `(dashboard)`; no tocar antes.
- **`onboarding_data`** — columna `jsonb` en `profiles`
  (migración `004_onboarding_data.sql`).
- **`profiles` lookups** — usar `.eq('user_id', user.id)`, no `.eq('id', user.id)`.
  La tabla tiene PK propia distinta del UUID de auth.
- **Embeddings — fire-and-forget**. No bloquean el guardado si fallan.
  Owner: AG01. Migración `006_embeddings_search.sql` + RPC `match_embeddings()`.
- **Rate limit chat free tier**: 20 queries/día contando `role='user'` en UTC.
  Lógica en `src/app/api/chat/route.ts`. No duplicar en cliente.
- **Migraciones SQL**: ejecutar en Supabase inmediatamente tras generarlas.
  Responsable: AG01 (validación) o quien haga el merge final.

## PRIMERA SESIÓN CONSIGLIERE
Al completar GDPR → Consigliere inicia conversación con bienvenida.
Extrae de la respuesta: meta principal, plazo, urgencia, miedo subyacente.
Todo se guarda estructurado en DB sin formulario.

## BACKLOG ACTUAL (post-pivot mayo 2026)
Fundacional:
- [x] 1.1 Repo + Next.js setup
- [x] 1.2 Schema Supabase + RLS
- [x] 1.3 Vercel pipeline funcionando
- [ ] 1.4 `app.andgcore.com` → apuntar dominio DNS
- [x] 1.5 Auth email + Google OAuth
- [x] 1.6 Onboarding + Quiz + GDPR (a refactorizar — ver pendientes)
- [x] 1.7 Dashboard ICA skeleton

Lógica de dominio:
- [x] Lógica fiscal Portugal
- [x] Algoritmo ICA completo
- [x] GDPR Pacto de Datos
- [x] Sistema de prompts CFO completo
- [x] ICA service integrado con Supabase (trigger 005)
- [x] Chat CFO con LLM real (gpt-4o-mini)
- [x] API transacciones completa con RAG
- [x] Embeddings + búsqueda semántica (pgvector)
- [x] Motor IDF — `idf.ts` + `idf-service.ts` + `api/idf/`
- [x] Prompts IDF actualizados

UX / Dashboard:
- [x] Dashboard con Consigliere (v3 — paleta + dopamina + dark mode)
- [x] Contraste fondo `#E8E3D9` vs cards `#FFFFFF` con sombra
- [x] Dark mode funcional con toggle sidebar
- [x] Modal fugas con advertencia + revertir 60s
- [x] Logout en sidebar
- [x] Nombre real usuario desde `profiles.name`

Pendientes inmediatos:
- [ ] Migración `007_goals_idf.sql` — ejecutar en Supabase
- [ ] Migrar `src/lib/llm.ts` → `src/lib/llm/router.ts` con sub-patrón router
- [ ] Crear `src/lib/llm/output-validator.ts` (disclaimer producto financiero)
- [ ] Crear `FORMULAS_IDF_ICA.md` (raíz) con desarrollo matemático completo
- [ ] Onboarding → solo GDPR + primera sesión Consigliere
- [ ] Memoria continua entre sesiones (RAG histórico en cada turno)
- [ ] Proactividad del Consigliere (agente inicia conversación)
- [ ] Día 4: TransactionForm UI + Stripe
- [ ] Renombrar `middleware.ts` → `proxy.ts` (AG03)
- [ ] Validar nombre comercial B2C en EUIPO

Fase 2+ (no tocar):
- [ ] Animaciones Lottie del Consigliere
- [ ] Open Banking
- [ ] Producto B2B
- [ ] Producto wellness biométrico
