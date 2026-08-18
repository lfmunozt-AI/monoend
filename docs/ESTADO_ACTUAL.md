# Estado actual — Truth Engine

**Actualizado:** 2026-08-18 (AG05)
**Referencia de comportamiento:** `docs/CONTRATO_TRUTH_ENGINE.md` (ver §16 Enmiendas, E1-E13)

---

## Qué hay en `develop`

Cabeza: `358c729` (14 de agosto, PR #56). **76 commits por delante de `main`.**

| Tanda | Qué entró | PRs | Estado del gate |
|---|---|---|---|
| Tanda 1 | Spans y fronteras posicionales; V11-V13 → contrato **E2** | — | — |
| Tanda 2 | Reconciliación cross-turno, **Gate G1c** | #49, #50, #51 | **G1c cerrado** — aprobado por AG01 por ejecución (`docs/informes/REVISION_AG01_tanda2_reconciliacion.md`) |
| Tanda 3 | V16 doble conteo (caso pegado) + V15 atribución única + test estructural de atribución | #52 | V16 **parcial** — ver M1 abajo |
| Memoria de usuario | Hechos financieros a `user_financial_state` (por `user_id`), diálogo por conversación; migración **021** | #55 | **E10 implementada** |
| QA testdev8 | La cifra pedida no se borra · responde lo preguntado · derivadas recalculadas del estado · desglose visible entre sesiones · dedup de ítems · M10 deja de republicar el RAW · guarda de sanidad bloqueante | #56 | **APROBADO CON RESERVAS** por AG01 (ronda 2) |

De la tanda QA testdev8 conviene retener el recorrido, porque es el que motiva **E11**: la ronda 1
fue **RECHAZADA** con la batería entera en verde (84/84 turnos, 0 fallos en 5 suites) — M10
republicaba el RAW del modelo con cifras no trazables (violando G1b) y el bloque "TU REALIDAD" se
contradecía a sí mismo. La ronda 2 verificó ambos cierres ejecutando contra `develop` y contra la
cabeza rechazada como controles.

**Invariantes nuevas implementadas y verificadas en esa tanda** (propuestas por AG01 en la ronda 1):

- **V17** — ninguna capa de reparación reintroduce una cifra eliminada por falta de respaldo
  (M10 ya no lee `ctx.raw`; solo escribe valores presentes en `conceptos`).
- **V18** — el bloque de datos verificados es internamente consistente; si la guarda de sanidad
  detecta divergencia, el desglose **se suprime** del bloque en vez de publicarse con un warning.

### Abierto en `develop`, sin bloquear merge

1. **M1 — doble conteo con palabra intermedia** (§16 **E12** del contrato). Condición **bloqueante
   de piloto**. Detalle y solución acordada en E12.
2. **M10 no detecta la anáfora con verbo.** `"Esa es tu capacidad real…"` — la frase canónica del
   QA testdev8, la que originó el Mandamiento 10 — no matchea `ANAFORA_SIN_ANTECEDENTE_RE`, que
   exige demostrativo + sustantivo de lista cerrada. AG01 lo puso como **condición de merge barata**
   (ampliar la regex al demostrativo + cópula y **reponer** el test con la frase canónica);
   aceptable diferirlo **solo si entra en la tanda inmediatamente siguiente**. Mitigado mientras
   tanto por el reintento acotado de `route.ts`, a coste de una llamada extra al LLM en la forma de
   respuesta más común. Casos **29** y **30** de la matriz (E13).
3. **`gastos_items` crece sin tope.** §8 fija cap de 5 versiones por campo; la dedup archiva
   (`superseded: true`) pero nunca colapsa. Desde E10 ese jsonb es **de usuario**, no de
   conversación: no se recicla nunca. Un desglose de 15 partidas re-enunciado cinco veces deja 75
   entradas.
4. **Un desglose de UN solo ítem por `tool_call` se descarta en silencio**
   (`toolArgsToScenarioDelta` devuelve delta vacío). Preexistente; roza V14.
5. **El desglose acumulado no admite "ahora son solo estas".** Si el usuario re-enuncia una lista
   más corta, las partidas anteriores siguen activas y el total las incluye. Ningún caso de la
   matriz lo cubre.
6. **La declaración de impacto de la última tanda no es artefacto del repo** — `git diff
   origin/develop...origin/agent/08 -- docs/` vacío en las dos rondas. Regla añadida en **E11**.

### Informes de revisión sin mergear

Las **dos últimas revisiones de AG01 viven solo en `origin/agent/01`** (`704f907` y `e029734`):
`docs/informes/REVISION_AG01_qa_testdev8.md` y `docs/informes/REVISION_AG01_qa_testdev8_ronda2.md`.
Son la evidencia de E11 y E12. **Están citadas en el contrato con su rama** (ver nota de referencia
de E2); entran a `develop` cuando se mergee `agent/01`.

## Qué hay en `main`

Cabeza: `713eb59` (**22 de julio**, PR #27). `main` está **casi un mes por detrás** de `develop`:
120 archivos y ~21.300 líneas de diferencia.

`main` **no tiene** el Truth Engine: ni la reconciliación cross-turno (G1c), ni la memoria de
usuario (E10), ni las tandas de spans/atribución/doble conteo, ni los 26 escenarios de regresión
añadidos desde entonces. Sus migraciones llegan hasta `010_scenario_state.sql`.

**Consecuencia práctica:** todo lo que este documento describe como "cerrado" está cerrado en
`develop`. Producción, mientras `main` no avance, corre el motor de julio.

## Migraciones

**En el árbol: `001` … `021_user_financial_state.sql`.**

**Todas ejecutadas en Supabase** (proyecto `sovereign-cfo`, `jmbzjcrgxetqfkqopfgr`), verificado
contra el esquema real el 18 de agosto: existen `response_telemetry` (011) con las columnas de
`019_telemetry_extraction` y `020_telemetry_conflict` (`extraction_status`, `delta_raw`,
`conflict_status`, `conflict_field`, `conflict_diff`, `conflict_attempts`, `assumed_fields`),
`telemetry_alerts` (012) y `user_financial_state` (021, con `user_state_persist_failed` en
telemetría).

`main` solo conoce hasta la `010`: **el orden de despliegue importa** — las migraciones ya están en
la BD, es el código de `main` el que va detrás.

## Las condiciones del 17 y su estado

La hoja de ruta anterior fijaba el piloto para el **17 de agosto**. **La fecha ya pasó** (hoy es 18)
y dos condiciones siguen abiertas. Estado real:

| # | Condición | Estado |
|---|---|---|
| 1 | **V15 + V16 generalizado** — cerrar el doble conteo con palabra intermedia | ❌ **ABIERTA.** V15 y V16 cerrados para el fraseo pegado (`"gasté 1800:"`); la M1 con palabra intermedia sigue viva y **más ancha** de lo que se registró: 3 de 4 fraseos fallan y 2 salen `COMPLETE`. Solución acordada en **E12** (invertir la regla, no enumerar conectores) |
| 2 | **Memoria de usuario** — hechos a nivel de usuario, diálogo por conversación | ✅ **CERRADA.** Migración 021 + partición `CAMPOS_HECHOS`/`CAMPOS_DIALOGO`/`CAMPOS_TRANSITORIOS`; verificada por AG01 en sesión nueva (cuota derivada del estado sin volver a pedirla, desglose enumerado entre sesiones). Casos **31** y **32** de la matriz (E13) |
| 3 | **`develop` → `main`** | ❌ **PENDIENTE.** Ver bloque de infraestructura |
| 4 | **Dominio** — apuntar DNS | ❌ **PENDIENTE** |
| 5 | **Separación de BD Preview/Production** en Supabase | ❌ **PENDIENTE** |
| 6 | **Auditoría RLS fresca** | ❌ **PENDIENTE**, con un hallazgo ya identificado (abajo) |
| 7 | **Piloto de una semana con datos reales de Luis** | ⛔ **NO ABIERTO.** La condición 1 es bloqueante de piloto por E12; las 3-6 son infraestructura sin la que el piloto no tiene dónde correr |

**Lectura honesta:** de las siete condiciones solo una está cerrada. El piloto no se puede abrir
hoy, y el motivo no es una sola pieza que falte: es una condición de comportamiento (M1) más los
cuatro bloques de infraestructura de abajo, ninguno empezado.

## Infraestructura pendiente — los cuatro bloques

### 1 · `develop` → `main`

`main` en `713eb59` (22 de julio). 76 commits, 120 archivos, ~21.300 líneas. Es el merge que pone
el Truth Engine en producción; hasta que ocurra, ninguna de las garantías de este documento aplica
a lo que ven usuarios reales. Las migraciones ya están ejecutadas en la BD, así que el merge no
arrastra DDL pendiente — pero sí conviene revisar que el código de julio no quede corriendo contra
un esquema de agosto durante la ventana de despliegue.

### 2 · Dominio

Backlog 1.4 de `CLAUDE.md`, pendiente desde el arranque. **Discrepancia sin resolver en la propia
documentación:** `CLAUDE.md` registra `app.andgcore.com` y la hoja de ruta anterior de este
documento registraba `monoend.andgcore.com`. Decisión de Luis antes de tocar DNS.

### 3 · Separación de bases de datos Preview/Production

Hoy Preview y Production comparten proyecto Supabase. Con el piloto corriendo sobre **datos
financieros reales de Luis**, cualquier despliegue de Preview escribe en la misma BD que el piloto.
Es la condición que peor envejece si se pospone: no es un problema hasta que lo es, y entonces son
datos reales.

### 4 · Auditoría RLS fresca — con un hallazgo ya en mano

Desde la última auditoría nacieron `response_telemetry`, `telemetry_alerts`, `goals` y
`user_financial_state`, todas con GRANTs propios y ninguna revisada desde su creación. Estado real
verificado contra el esquema el 18 de agosto:

- **RLS activo en las 18 tablas de `public`.** Ninguna sin `rowsecurity`.
- **Hallazgo — `anon` alcanzado por la política de `messages`.** La política
  `"Users can manage own messages"` (`001_initial_schema.sql`) es `FOR ALL` **`TO public`**, y
  `public` incluye a **`anon`**. Hoy no hay fuga: `anon` no tiene `SELECT`/`INSERT`/`UPDATE`/
  `DELETE` sobre `messages` (solo `REFERENCES`/`TRIGGER`/`TRUNCATE`, el default del schema), y
  `auth.uid()` es `NULL` para `anon`, así que el `USING` tampoco casaría. **Pero la única barrera
  efectiva es el GRANT**: un `grant select on public.messages to anon` en cualquier migración futura
  abre la tabla sin tocar una sola política. La conversación completa del usuario con el
  Consigliere vive ahí. **Corrección:** recrear la política como `TO authenticated` — defensa en
  profundidad, coste una migración. El mismo patrón `TO public` está en `conversations`, `goals` y
  `user_financial_state`.
- **`user_financial_state` sin GRANT para `authenticated`.** Tiene política de `SELECT` propia
  (`auth.uid() = user_id`) pero el rol `authenticated` no tiene `SELECT` sobre la tabla: hoy solo la
  alcanza `service_role` desde el servidor. Es coherente con cómo la usa `route.ts` — pero la
  política sugiere una intención de lectura desde cliente que el GRANT no concede. Decidir cuál de
  las dos es la verdad y dejar la otra alineada.
- **`response_telemetry` y `telemetry_alerts`: RLS activo y CERO políticas.** Es el cierre correcto
  (`revoke all … from anon, authenticated` en 011 y 012; solo `service_role` entra), pero conviene
  dejarlo escrito para que nadie "arregle" la ausencia de políticas añadiendo una.

---

## Nota de proceso — la regla que faltaba (E11)

Esta entrega añade al contrato la regla que la serie entera venía pidiendo: **eliminar, debilitar o
cambiar el aserto de un test existente exige justificación explícita en la Declaración de Impacto,
igual que eliminar una función**, y **la Declaración de Impacto es un artefacto del repo en
`docs/informes/`, no el mensaje de commit**.

No es una regla preventiva: el patrón ocurrió **cinco veces** en esta serie, tabuladas en E11 con su
informe. En las cinco la batería quedó **verde sobre código incorrecto**, y en las cinco lo detectó
la revisión cruzada (E6), no la batería del implementador. Es la justificación empírica de que E6
sea obligatorio y no opcional.
