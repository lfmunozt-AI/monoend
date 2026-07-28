# AUDITORÍA AG06 — Coherencia ICA/IDF (implementación vs. `FORMULAS_IDF_ICA.md`)

> Agente: AG06 (FinOps Auditor) · Modo: análisis (sin corrección de lógica)
> Fecha: 2026-07-27 · Base: `agent/06` rebaseado sobre `origin/develop` @ `70f1dd2`
> Documento canónico: `FORMULAS_IDF_ICA.md` (raíz del repo, v1.0, mayo 2026)
> BD auditada: proyecto Supabase `sovereign-cfo` (`jmbzjcrgxetqfkqopfgr`), consultada en vivo
> el 2026-07-27 vía MCP (`execute_sql`) — no solo lectura de migraciones en disco.

---

## Resumen ejecutivo

El dashboard que el usuario ve hoy **no muestra IDF**: muestra el score ICA (contador de
`chat_consulta`, +2 por mensaje) re-etiquetado como "IDF" con niveles Bronce/Plata/Oro/
Diamante. La función SQL `calcular_idf_dimensions()` y su equivalente TypeScript existen,
están bien implementados y coinciden con el documento canónico en pesos — pero **ninguno
de los dos está cableado a ningún endpoint ni componente**. En paralelo, existen **tres
implementaciones distintas del score ICA** en el repo (una activa en producción, dos
muertas), y ninguna de las tres coincide con la fórmula de 5 componentes del documento
canónico. Los "eventos que suman ICA" documentados (`transaccion_registrada`,
`meta_definida`, `extracto_subido`, `hito_alcanzado`, etc.) **nunca se disparan en
producción** — 100 de 102 filas de `ica_history` tienen `event_trigger = 'chat_consulta'`.

---

## Hallazgos — IDF

### [CRÍTICO] IDF nunca se calcula para el usuario; el dashboard muestra ICA disfrazado de IDF

- `src/lib/idf/calculator.ts` (`calcularIDF`) no es importado por ningún archivo del
  repo fuera de sus propios tests (`grep -rn "calcularIDF" src/` → 0 llamadas desde
  `src/app`). No existe ruta `src/app/api/idf/*`.
- El hero "IDF" del dashboard (`src/app/(dashboard)/dashboard/page.tsx:334`,
  `<IdfCircle score={animIdf} realScore={data.score} ...>`) recibe `data.score`, que
  viene de `fetch('/api/ica/score')` (línea 141) — el mismo `GET` que alimenta el
  círculo ICA. No hay ninguna llamada a `calcular_idf_dimensions` ni a `calcularIDF`
  en el flujo del dashboard.
- Consecuencia directa: el usuario ve "IDF subió" cuando en realidad lo que subió es el
  contador de consultas al chat (ver hallazgo ICA-1). Esto viola explícitamente la regla
  de CLAUDE.md ("ICA e IDF son métricas independientes... no confundir") en la propia UI
  de producción.
- La función SQL sí existe y funciona: verificado con `execute_sql` contra el proyecto
  vivo — `calcular_idf_dimensions` está presente en `pg_proc`.

### [MENOR] Umbrales de nivel IDF: off-by-one en los bordes 25/30 y 75/76

- Doc: Bronce 0–25 · Plata 26–50 · Oro 51–75 · Diamante 76–100 (rangos cerrados, sin huecos).
- `src/lib/idf/calculator.ts` (según INFORME.md del propio commit nocturno): mismos
  cortes — coincide.
- `src/app/(dashboard)/dashboard/page.tsx:65-70` (`getIdfLevel`, la que realmente pinta
  la UI): `< 30` Bronce, `< 50` Plata, `< 76` Oro, resto Diamante. Los puntos 26–29 caen en
  Bronce en vez de Plata, y 76 exacto ya es Diamante en ambas — coincide ahí, pero el corte
  bajo (25 vs 30) diverge del doc. Impacto bajo (ni siquiera es el score IDF real, ver
  hallazgo anterior), pero si se cablea IDF de verdad hay que alinear esta función también.

### [OK] Pesos y fórmula maestra IDF coinciden con el documento

- `supabase/migrations/008_idf_function.sql:162-165`: `0.40*progreso + 0.25*fugas +
  0.20*estabilidad + 0.15*ahorro` — coincide exactamente.
- `src/lib/idf/calculator.ts` — traducción fiel confirmada por su propio commit
  (`ag06: calculator idf+ica con 35 tests`), pesos 40/25/20/15 idénticos.
- Precondición "sin meta activa → null + `no_goal_declared`" implementada en ambos.

---

## Hallazgos — ICA

### [CRÍTICO] Tres implementaciones distintas de "ICA" coexisten; solo una está viva, y no es la del doc

1. **`src/lib/ica.ts::calcularICA`** — sistema de puntos por evento con topes
   (`CAPS`, `MAX_PUNTOS = 215`), normalizado a 0–100. **No se llama desde ningún
   endpoint** (`grep` confirma cero callers fuera de tests).
2. **`src/lib/ica-service.ts::updateICAScore` / `computeNewScore`** — suma aditiva simple
   sin normalización (`score = min(100, current + delta)`), con su propia tabla de
   eventos (`transaccion_registrada:5, meta_definida:10, extracto_subido:15,
   onboarding_completado:20, hito_alcanzado:25`) — **distinta** de la de `ica.ts` (que
   tiene `proyeccion_generada:20` en vez de `onboarding_completado`). Expuesta vía
   `POST /api/ica/score`, pero **ningún componente del frontend llama a este POST**
   (`grep -rn "api/ica/score" src/` solo encuentra el `GET` en el dashboard). Endpoint
   muerto en la práctica.
3. **`src/lib/ica/calculator.ts::calcularICA`** (módulo nuevo, este mismo commit
   nocturno AG06) — la única que se parece al documento: 5 componentes ponderados
   (perfilCompleto, profundidadHistorica, diversidadFuentes, consistencia, engagement).
   **Tampoco tiene caller fuera de sus tests.**

- Lo que **realmente** escribe `ica_history` en producción es un cuarto camino, inline
  en `src/app/api/chat/route.ts:664-679`: cada respuesta del Consigliere suma **+2** al
  último score (`Math.min(100, currentICA + 2)`), con `event_trigger: 'chat_consulta'`,
  sin pasar por ninguna de las tres funciones anteriores.
- **Verificado en BD real** (no solo código): `select event_trigger, count(*) from
  ica_history group by 1` → `chat_consulta: 100`, `rls-audit-marker: 2` (marcador de test
  de RLS). **Cero filas** de `transaccion_registrada`, `meta_definida`, `extracto_subido`,
  `hito_alcanzado`, `document_upload` ni ningún otro evento "documentado". El brief de
  esta tarea mencionaba `document_upload` como evento activo — no existe ese literal en
  ningún archivo de `src/`.

### [CRÍTICO] `005_ica_trigger.sql` (función `fn_ica_level`, aún con `'soberania'`) nunca se desplegó — CLAUDE.md documenta una arquitectura que no existe en producción

- CLAUDE.md ("ICA — única fuente de verdad via trigger", 2026-05-15): *"El ICA solo se
  incrementa via trigger Supabase (`005_ica_trigger.sql`)... nunca calcular ni mutar ICA
  desde el código de aplicación"*.
- Verificado contra la BD real: `select trigger_name from information_schema.triggers
  where trigger_schema='public'` → solo `conversations_updated_at` y
  `goals_set_updated_at`. **No existe ningún trigger sobre `ica_history` ni
  `transactions` que dispare `fn_ica_level`**, y `fn_ica_level` **no existe** como
  función en la BD (`pg_proc` vacío para ese nombre).
- En la práctica, el ICA se muta **exclusivamente desde código de aplicación**
  (`chat/route.ts`, inline) — exactamente lo que CLAUDE.md dice que nunca debía pasar.
  El archivo `005_ica_trigger.sql` quedó en el repo como migración que aparenta estar
  activa (y que **todavía contiene el literal prohibido `'soberania'`** en
  `fn_ica_level`, línea 16) pero es código muerto: si alguien la reejecuta hoy,
  reintroduce tanto el trigger fantasma como el string prohibido. No se modifica en este
  commit (Tarea 1 se limitó a `src/` y al backfill de datos ya escritos); queda para que
  Luis decida si se retira o se re-arma como trigger real.

### [MAYOR] Pesos ICA del módulo nuevo (`src/lib/ica/calculator.ts`) no coinciden con el documento canónico

| Componente | Doc (peso) | `ica/calculator.ts` (peso) |
|---|---|---|
| PerfilCompleto | 25% | 20% |
| ProfundidadHistorica | 25% | 25% ✓ |
| DiversidadFuentes | 20% | 20% ✓ |
| Consistencia | 15% | 15% ✓ |
| Engagement | 15% | 20% |

Explicación: el módulo se escribió (commit nocturno) **antes** de que existiera
`FORMULAS_IDF_ICA.md` en el repo — el propio INFORME.md de ese commit lo declara
explícitamente ("`FORMULAS_IDF_ICA.md` no existe... las fórmulas se tradujeron desde
`idf.ts`"; para ICA no había contrato pre-pivot, así que el módulo estableció uno propio
con esos 5 nombres pero pesos distintos). El doc canónico se añadió después
(commit `9261165: docs: añadir FORMULAS_IDF_ICA.md canónico v1.0`), sin que nadie
retro-alineara el módulo. Como el módulo tampoco está cableado (hallazgo anterior), el
impacto hoy es cero en producción, pero bloquea usarlo tal cual el día que se active.

### [MAYOR] Definiciones de los componentes ICA no coinciden con el doc, más allá del peso

- **PerfilCompleto**: doc pide 8 campos (país, rango edad, situación laboral, régimen
  fiscal, ingreso neto declarado, meta activa, plazo de meta, reserva de emergencia
  identificada). `ica/calculator.ts::dimPerfilCompleto` (líneas 156-168) evalúa 7 campos
  **distintos**: `name`, `country`, `language`, `onboarding_done`, `fiscal.country`,
  `fiscal.employment_type`, `fiscal.monthly_gross`. No hay solapamiento con "meta activa"
  ni "plazo de meta" ni "reserva de emergencia" del doc.
- **DiversidadFuentes**: doc mide *canales de entrada de datos* (manual / upload / email
  / OAuth PSD2). `dimDiversidadFuentes` (líneas 204-213) mide *categorías de gasto
  distintas* — una métrica de otra naturaleza bajo el mismo nombre.
- **Consistencia**: doc mide varianza presupuesto-vs-gasto-real por categoría.
  `dimConsistencia` (según comentario línea 217-220) mide *% de semanas con actividad en
  las últimas 8* — de nuevo, métrica distinta bajo el mismo nombre (se parece más al
  concepto de "Engagement" del doc que a "Consistencia").
- Es una reimplementación paralela y coherente internamente, pero no es intercambiable
  con el contrato de `FORMULAS_IDF_ICA.md` campo a campo — requeriría reescritura, no
  solo ajuste de pesos.

### [MAYOR] Niveles narrativos ICA no coinciden con el doc

- Doc: 4 niveles narrativos — 0–30 / 31–60 / 61–85 / 86–100, con mensaje del Consigliere
  por nivel ("Te conozco poco...", etc.).
- `src/lib/ica.ts::getICALevel` (la función que realmente escribe `ica_history.level`
  en producción): 3 niveles técnicos — `ceguera` (≤30) / `vision` (≤70) / `dominio`
  (>70) (renombrado en esta misma entrega, Tarea 1). Corte medio en 70 vs. 60/85 del
  doc; solo 3 tramos, no 4; sin mensajes narrativos asociados — esos viven aparte, en el
  prompt del Consigliere.

### [OK] La corrección `'soberania'` → `'dominio'` (Tarea 1) no introduce más discrepancias

`getICALevel` es un identificador técnico interno (fila de `ica_history`), no el nombre
de nivel narrativo del documento; renombrar el tercer tramo no cambia los umbrales ni la
lógica, solo el literal.

---

## Tabla resumen de severidad

| # | Hallazgo | Área | Severidad |
|---|---|---|---|
| 1 | Dashboard muestra ICA (`chat_consulta` +2) como si fuera IDF; IDF real nunca se invoca | IDF | Crítico |
| 2 | Tres implementaciones de ICA coexisten; ninguna wired coincide con el doc; el path real es un +2 inline en `chat/route.ts` | ICA | Crítico |
| 3 | `005_ica_trigger.sql` documentado como "única fuente de verdad" pero no desplegado; ICA se muta desde app code, lo contrario de lo que dice CLAUDE.md | ICA | Crítico |
| 4 | Pesos de `ica/calculator.ts` no coinciden con el doc (perfilCompleto 20 vs 25, engagement 20 vs 15) | ICA | Mayor |
| 5 | Definiciones de PerfilCompleto/DiversidadFuentes/Consistencia en `ica/calculator.ts` miden cosas distintas a las del doc bajo el mismo nombre | ICA | Mayor |
| 6 | Niveles narrativos ICA del doc (4 tramos) no coinciden con `getICALevel` (3 tramos, cortes distintos) | ICA | Mayor |
| 7 | Umbral bajo de nivel IDF en la UI (`<30` vs doc `≤25`) | IDF | Menor |

---

## No incluido en este informe (fuera de alcance de Tarea 2)

- No se corrige ninguna lógica de cálculo ni se cablea IDF/ICA a nuevos endpoints —
  decisión pendiente de Luis antes del piloto, según el brief.
- No se toca `005_ica_trigger.sql` ni se elimina el trigger fantasma — mismo motivo.
- La Tarea 1 (backfill `'soberania'`→`'dominio'`) sí se ejecutó y es independiente de
  estos hallazgos: afecta solo el literal de nivel, no qué función lo calcula.

---

## Actualización 2026-07-28 — qué se corrigió en esta tanda y qué queda como deuda aceptada

Decisión de Luis: solo se arregla lo que el usuario ve. Esto es lo que cambió respecto
al informe original de arriba, y lo que se deja explícitamente para después del piloto.

### Resuelto en esta tanda

- **Hallazgo #1 (crítico, IDF nunca calculado)** — **RESUELTO.** Nuevo endpoint
  `GET /api/idf/score` invoca `calcularIDF()` de verdad (RPC `calcular_idf_dimensions`
  con fallback TS) y devuelve `{ hasGoal, score, level, dimensions, goal }` — nunca
  inventa un componente que falte, lo refleja `null`. Verificado end-to-end contra la
  RPC real en BD (no solo en tests): con meta activa devuelve `score`/`nivel`/
  componentes reales; sin meta, `{ hasGoal: false, reason: 'no_goal_declared' }`.
  Sustituye al `data.score` de `/api/ica/score` que el dashboard usaba como IDF.
- **Hallazgo #7 (menor, off-by-one de niveles IDF)** — **RESUELTO** en la fuente:
  `levelFromScore()` de `src/lib/idf/calculator.ts` (cortes exactos 25/26, 50/51,
  75/76 del documento) queda exportada junto con `getIdfLevelDisplay()` para que AG04
  sustituya la copia local desalineada de `dashboard/page.tsx`. La sustitución en el
  componente UI en sí es trabajo de AG04, no de este commit.
- **Niveles narrativos ICA** — renombrados de `ceguera/vision/dominio` a nomenclatura
  de CONOCIMIENTO (`conocimiento_inicial/parcial/pleno`), con `getICALabel()`
  trilingüe. Mismos umbrales (≤30/≤70/>70) — no se tocó la lógica, solo el
  vocabulario. Esto **no** resuelve el hallazgo #6 (el doc canónico sigue
  especificando 4 tramos narrativos con mensajes propios del Consigliere, distintos de
  estos 3 niveles técnicos) — solo evita que el vocabulario interno choque con IDF.

### ACEPTADO PARA EL PILOTO — no se toca

- **[ACEPTADO PARA EL PILOTO] Tres implementaciones paralelas de ICA.** Siguen
  coexistiendo `ica.ts::calcularICA` (puntos+CAPS, muerta), `ica-service.ts::
  updateICAScore` (aditivo simple vía `POST /api/ica/score`, endpoint sin caller real)
  y `ica/calculator.ts::calcularICA` (5 componentes ponderados, muerta). El camino que
  realmente escribe `ica_history` en producción sigue siendo el `+2` inline por
  `chat_consulta` en `chat/route.ts`. No se consolida ni se cablea ninguna de las tres
  — el usuario no ve estas rutas muertas, así que quedan fuera del criterio "solo se
  arregla lo que el usuario ve".
- **[ACEPTADO PARA EL PILOTO] Pesos y definiciones de `ica/calculator.ts` divergen del
  documento canónico.** PerfilCompleto (20% vs 25% doc), Engagement (20% vs 15% doc), y
  las definiciones de PerfilCompleto/DiversidadFuentes/Consistencia miden campos
  distintos a los especificados en `FORMULAS_IDF_ICA.md`. Como el módulo no está
  cableado a ningún endpoint (ver punto anterior), no hay usuario afectado hoy; se
  documenta para cuando alguien decida activarlo.
- **[ACEPTADO PARA EL PILOTO] Niveles narrativos ICA de 4 tramos sin implementar.** El
  documento especifica 4 mensajes del Consigliere por rango (0–30/31–60/61–85/86–100);
  lo único que existe en producción son 3 niveles técnicos con cortes en 30/70 (ahora
  con nomenclatura de conocimiento) y un diagnóstico de 3 tramos aparte en
  `consigliere.ts` (`ICA_DIAGNOSTICO`, ahora también sincronizado a la nomenclatura de
  conocimiento pero sin los 4 tramos del doc). Implementar el cuarto tramo narrativo
  requeriría decidir primero cuál de las tres implementaciones de ICA es la fuente de
  verdad — bloqueado por el punto anterior.
- **`005_ica_trigger.sql`** — no se elimina el archivo, se neutraliza como NO-OP con
  cabecera explicativa (Tarea 3 de esta tanda). El ICA sigue mutándose desde código de
  aplicación, tal como confirma esta auditoría; formalizar esa arquitectura (o revivir
  un trigger real) queda pendiente de decisión de Luis.
