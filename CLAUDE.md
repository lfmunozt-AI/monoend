# CLAUDE.md — AndgCore Technology
# Actualizado: 2026-07-08 (sprint migración 5 capas · ADN · terminología unificada)

---ADN---
**monoend NO es un AaaS de finanzas personales genérico. Es un AaaS PREDICTIVO
que organiza y materializa metas financieras.**

El ciclo, en orden, y no hay otro:

1. El usuario establece la meta **EN CONJUNTO** con monoend. No la declara solo.
2. monoend **evalúa fricción, riesgos y realidad actual** según el ICA suministrado.
3. monoend **presenta una propuesta**.
4. **Acuerdan mutuamente.**
5. **Arranca el sprint.**
6. **Seguimiento constante**: mitiga riesgos, mide desviaciones, recalcula rumbo,
   replantea imprevistos, **entrega la realidad** (no consuelo).

**Toda respuesta cierra con una de estas tres, nunca con nada más:**
- una **propuesta concreta**, o
- la **petición del dato que falta**, o
- la **confirmación de cierre**.

Una respuesta que termina en pregunta abierta vacía, en ánimo, o en un resumen
sin siguiente jugada, es un defecto — no un matiz de estilo.
---FIN ADN---

## EMPRESA
AndgCore Technology — pre-incorporación, sede planificada Iberia (PT+ES).
Founder solo: Luis Muñoz. Capital propio, runway ~6 meses, buscando ronda.

## TRES PRODUCTOS BAJO ANDGCORE
1. **Producto B2C (Fase 1, actual)** — agente IA predictivo de metas financieras.
   Nombre comercial: **monoend**. Pendiente validación EUIPO y renombre del repo
   (hoy sigue siendo `sovereign-cfo`). Dominio operativo previsto: app.andgcore.com.
2. **Producto B2B (Fase 2)** — ~2 años post Fase 1 live. No tocar todavía.
3. **Producto wellness biométrico (Fase 3)** — ~3 años post Fase 2 live. No tocar.

## TERMINOLOGÍA OFICIAL
- **MVP** (no MIP, no MLP).
- **IDF**: métrica **protagonista de progreso hacia la meta** declarada por el
  usuario. Se usa siempre como sigla.
  > NO expandir como "Índice de Dominio Financiero". *Dominio Financiero* es el
  > **nivel/concepto** más alto, no el nombre del índice.
- **ICA — Índice de Certeza Algorítmica** (nombre provisional unificado): métrica
  secundaria de qué tanto el sistema conoce al usuario. Unifica y reemplaza los
  nombres viejos ("Índice de Control Autónomo", "Índice de Conocimiento del
  Asistido", y demás variantes). Un solo nombre en todo el repo.
- **The Consigliere**: nombre **INTERNO** del modelo LLM. NUNCA traducir.
  En UI aparece **solo como badge**. Nunca en el cuerpo de los mensajes: el
  Consigliere no se nombra a sí mismo al hablar.
- **Reserva de Imprevistos**: fondo de emergencia. Término **multiidioma**;
  reemplaza toda variante anterior sin excepción.
- **Fuga de Poder**: gasto innecesario / impulsivo.
- **Escudo Familiar**: seguros / protección patrimonial.
- **Escenario de Poder**: proyección what-if.
- **Hito**: milestone del IDF (alcanzar 25%, 50%, 75%, 100%).
- **Dominio Financiero**: nivel máximo.

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

**Regla de credenciales (LLM Router)**: las claves de API viven **solo** en el
entorno del servidor (`process.env.*`) y se leen **dentro del provider**.
`LLMRequest` **no tiene** ni tendrá campo `apiKey`. Un provider sin su clave lanza
`LLMError(code: 'AUTH')`; nunca hace una llamada de red a ciegas. Ningún cliente,
prompt, log ni tabla toca una credencial.

Estado real hoy — leer antes de tocar LLM:
- `src/lib/llm/router.ts` **existe** (`callLLM(req)` despacha a openai / together /
  mistral / custom, mide latencia, normaliza errores a `LLMError`).
- **Nadie lo consume todavía.** `api/chat/route.ts` y `api/transactions/route.ts`
  siguen importando el viejo `src/lib/llm.ts`. La migración de consumidores está
  en el backlog.
- Sub-patrones vigentes en `src/lib/llm.ts`: `callLLMJson<T>()` (structured,
  `temperature: 0.2`), `callLLM()` (fallback sin throw), `callLLMWithHistory()`.
- Owner: AG08. Otros agentes solo consumen. Guía: `docs/llm-router.md`.

## REGLAS ABSOLUTAS
1. Solo features **B2C** en esta fase. No tocar lógica B2B ni wellness.
2. **RLS activa** en TODAS las tablas Supabase.
3. **Nunca** almacenar IBANs, credenciales bancarias, NIFs / NIEs.
4. The Consigliere **nunca** recomienda producto financiero específico sin
   disclaimer (validador en `src/lib/llm/output-validator.ts`).
5. **Idioma del código: inglés. UI default: español.**
6. CSS animations v1; **Lottie en Fase 2**.
7. **Prohibida la palabra "soberanía / soberano" en TODO** — UI, prompts, copy,
   nombres de término, identificadores nuevos. **Sin excepción.**
   (Deroga la excepción anterior que permitía el término técnico acuñado para el
   fondo de emergencia. Ese término ya no existe: es **Reserva de Imprevistos**.)
8. LLM: gpt-4o-mini vía router · NO usar GPU local.
9. Plan en sidebar: "Élite · activo" + "Ver beneficios".
10. **Ninguna cifra monetaria sin fundamento.** Ver `docs/GUARDRAIL.md` y la
    tercera vía de cifras estándar.

## TERCERA VÍA DE CIFRAS ESTÁNDAR
Ante una cifra que el usuario **no ha aportado**, el modelo no tiene dos vías
(inventarla · callarse). Tiene **tres**:

1. **Hecho** — la cifra viene de un dato que el usuario dio. Se usa.
2. **Cálculo** — la cifra se deriva de un hecho, o la produjo el motor financiero
   (`src/lib/calculator`). Se usa.
3. **Cifra estándar** ← *la tercera vía*. No es un monto: es un **porcentaje o una
   regla general del dominio** ("el 20% del ingreso", "de 3 a 6 meses de gastos").
   Se enuncia **como regla**, nunca materializada en euros que nadie aportó.

Todo lo demás — un **monto absoluto** sin respaldo — se **bloquea**. El guardarraíl
elimina la frase que lo contiene y cierra pidiendo el dato que falta.

Implementación: categorías `hecho` · `calculo` · `concepto` en
`src/lib/guardrail/validate.ts`. La tercera vía es la categoría `concepto`
(`isPercent()` / `isTimeUnit()`).

## REGLAS DE PROCESO — NO DESVIAR
- **QA se valida SOLO en el alias `git-develop`** de Vercel. **Nunca** en URLs de
  deployment con hash (`...-abc123.vercel.app`): son inmutables y apuntan a un
  commit viejo. Un bug "que sigue ahí" en una URL hash casi siempre ya está
  arreglado en el alias.
- **Los PR de agentes van SIEMPRE con base `develop`.** Nunca `main`.
  GitHub propone `main` por defecto: hay que **cambiarlo a mano** en cada PR.
  (Ver incidente PR #1 / #2 en `PROJECT_LOG.md`, 2026-07-06.)
- **`--force-with-lease` solo sobre la propia rama `agent/XX`.** Jamás sobre
  `main`, `develop` ni la rama de otro agente. Nunca `--force` a secas.
- Flujo: `agent/XX → develop → main`. Los merges los aprueba Luis.
- **Informes**: van a `docs/informes/`, **un archivo por agente y fecha**
  (`INFORME_AGXX_YYYY-MM-DD.md`). Nunca un `INFORME.md` en la raíz: dos agentes
  entregando el mismo día producen un conflicto add/add garantizado.

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

| Agente | Worktree                | Dominio                                              |
|--------|-------------------------|------------------------------------------------------|
| AG01   | wt-ag01-arquitecto      | Arquitectura, validación, transacciones, embeddings  |
| AG02   | wt-ag02-datos           | Schema Supabase, migraciones, modelos de datos       |
| AG03   | wt-ag03-security        | Middleware, auth, RLS, renombre a `proxy.ts`         |
| AG04   | wt-ag04-ux              | Componentes UI, dashboard, chat UI, onboarding       |
| AG05   | wt-ag05-docs            | CLAUDE.md, AGENTS.md, PROJECT_LOG.md, docs/informes/ |
| AG06   | wt-ag06-finops          | Fiscal, proyecciones, ICA service, IDF service       |
| AG07   | wt-ag07-testing         | Tests unitarios e integración                        |
| AG08   | wt-ag08-consigliere     | LLM router, prompts, chat route, RAG, guardrail      |
| AG09   | wt-ag09-dopamina        | Gamificación, modal fugas, micro-feedback            |
| AG10   | wt-ag10-shield          | GDPR, privacy, Pacto de Datos, export/delete         |

Proceso obligatorio por agente (ver `PROJECT_LOG.md`):
1. `git branch` → verificar `agent/XX`.
2. `git fetch origin && git reset --hard origin/develop`.
3. Leer `PROJECT_LOG.md` y `CLAUDE.md`.
4. Trabajar solo en archivos de su dominio.
5. `git push origin agent/XX` ÚNICAMENTE. PROHIBIDO push a main/develop o
   ramas de otros agentes.
6. Abrir PR con **base `develop`**. Reportar Fase 4 y esperar aprobación de Luis.

## INFRAESTRUCTURA — VERCEL
- PRD: `sovereign-cfo.vercel.app` (rama `main`).
- QA: alias `git-develop` (rama `develop`). **Validar solo aquí.**
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
- **Guardarraíl de cifras — 5 capas** (sprint 2026-07-06/08, migrado desde
  ModeloCFO). El **código calcula, el modelo solo redacta**. Detalle completo,
  mapa de archivos y tests en **`docs/GUARDRAIL.md`**.
  Estado de cableado (importa: migrado ≠ en el camino de la request):
  | Capa | Archivo | ¿En la request? |
  |---|---|---|
  | Guardrail entrada (inyección) | `src/lib/guardrail/injection.ts` | ❌ solo exportada |
  | Guardrail salida (grounding) | `src/lib/guardrail/{extract,validate,policy,schema}.ts` | ✅ `chat/route.ts` |
  | Calculadora | `src/lib/calculator/` | ❌ solo en tests |
  | LLM Router | `src/lib/llm/router.ts` | ❌ nadie lo importa |
  | Bitácora `guardrail_log` | `supabase/migrations/009_guardrail.sql` | ✅ vía `runGuardrail` |
- **Política guardrail `mvp` v2 (deduplicación)**: cuando se bloquea una cifra se
  **elimina la frase entera** y se añade **UNA SOLA** línea de cierre pidiendo el
  dato. v1 insertaba la plantilla una vez por cifra: tres montos inventados →
  la misma frase tres veces. Modo `passthrough` solo loguea (para medir sin
  alterar UX). `src/lib/guardrail/policy.ts`.
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
- **Latencia del chat**: sin `setTimeout` artificial en la UI. Las 6 consultas de
  contexto van en un único `Promise.all`. No reintroducir esperas cosméticas.
- **Contrato API chat**: el endpoint devuelve `{ response, conversationId,
  tokensUsed }`. El cliente lee `response`. Los timestamps los pone el cliente al
  renderizar — el server no manda `createdAt` (era la causa del `Invalid Date`).
- **Migraciones SQL**: ejecutar en Supabase inmediatamente tras generarlas.
  Responsable: AG01 (validación) o quien haga el merge final.

## PRIMERA SESIÓN CONSIGLIERE
Al completar GDPR → Consigliere inicia conversación con bienvenida.
Extrae de la respuesta: meta principal, plazo, urgencia, miedo subyacente.
Todo se guarda estructurado en DB sin formulario.

## BACKLOG ACTUAL
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
- [x] `FORMULAS_IDF_ICA.md` canónico v1.0
- [x] Migraciones `007_goals_table.sql` + `008_idf_function.sql` aplicadas
- [x] **Sprint migración 5 capas ModeloCFO → repo** (guardrail entrada/salida,
      calculadora, LLM Router agnóstico + regla de credenciales, cableado en chat
      route, migración `009_guardrail.sql`)
- [x] Guardrail política `mvp` v2 con deduplicación de la línea de cierre
- [x] Persona ADN v2.1 del Consigliere
- [x] `output-validator.ts` (disclaimer + branding "Reserva de Imprevistos")
- [x] Tercera vía de cifras estándar (categoría `concepto`)

UX / Dashboard:
- [x] Dashboard con Consigliere (v3 — paleta + dopamina + dark mode)
- [x] Contraste fondo `#E8E3D9` vs cards `#FFFFFF` con sombra
- [x] Dark mode funcional con toggle sidebar
- [x] Modal fugas con advertencia + revertir 60s
- [x] Logout en sidebar
- [x] Nombre real usuario desde `profiles.name`
- [x] Fix contrato API chat (`Invalid Date` en timestamps)
- [x] Latencia: eliminado el delay artificial de 1s

Pendientes inmediatos:
- [ ] **Renombrar repo → `monoend`** (hoy `sovereign-cfo`; arrastra la URL de
      Vercel y los remotes de los 10 worktrees)
- [ ] **Cablear el LLM Router**: migrar `api/chat` y `api/transactions` de
      `src/lib/llm.ts` → `src/lib/llm/router.ts` (AG08)
- [ ] **Cablear la calculadora**: inyectar `buildVerifiedContext()` en el prompt y
      pasar `cifrasCalculadas` a `validateGrounding()` (hoy el 3er argumento
      nunca se usa fuera de los tests)
- [ ] **Cablear `detectInjection()`** en la entrada del chat (hoy solo exportada)
- [ ] Ejecutar / verificar `009_guardrail.sql` en Supabase
- [ ] **Streaming diferido** — rama `feature/streaming-buffer`, local, sin subir.
      El guardarraíl exige bufferizar la respuesta completa antes de validarla,
      así que la UX de streaming token-a-token queda aparcada
- [ ] **Deuda `getICALevel` devuelve `'soberania'`** (`src/lib/ica.ts:112`) y ese
      literal se persiste en `ica_history.level`. Viola la regla absoluta 7.
      Requiere migración + backfill. Owner: **AG06**
- [ ] Links 404 en el sidebar
- [ ] Markdown crudo renderizado en el chat (el usuario ve `**texto**`)
- [ ] Onboarding → solo GDPR + primera sesión Consigliere
- [ ] Memoria continua entre sesiones (RAG histórico en cada turno)
- [ ] Proactividad del Consigliere (agente inicia conversación)
- [ ] Día 4: TransactionForm UI + Stripe
- [ ] Renombrar `middleware.ts` → `proxy.ts` (AG03)
- [ ] Validar nombre comercial `monoend` en EUIPO

Fase 2+ (no tocar):
- [ ] Animaciones Lottie del Consigliere
- [ ] Open Banking
- [ ] Producto B2B
- [ ] Producto wellness biométrico
