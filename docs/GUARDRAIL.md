# Guardarraíl de cifras — arquitectura y tercera vía

> **Principio rector: el código calcula, el modelo solo redacta.**
>
> Un LLM que produce un monto en euros que nadie le dio está alucinando, aunque
> suene razonable. El guardarraíl es una capa de **código puro** (regex +
> aritmética, sin llamadas a ningún LLM, edge-safe) que envuelve la respuesta ya
> generada y decide qué cifra sobrevive.

Migrado desde ModeloCFO en el sprint del 2026-07-06/08. Evolucionado desde
entonces (tanda 2026-07-22 → pipeline unificado, tanda 2026-07-30 → "bloquear
sin sustituir" + validación cifra a cifra, sprint 2026-08 → Truth Engine).

**Relación con `docs/PIPELINE_CONTRACT.md`:** ese documento es la autoridad
sobre el **orden de capas del postprocesado** (`applyEnforcement` en
`pipeline.ts`), la responsabilidad única de cada una y las invariantes de
salida (a)-(e). **No se duplica aquí.** Este documento cubre lo que
`PIPELINE_CONTRACT.md` no cubre: la extracción de hechos de entrada, la
tercera vía de cifras estándar, el módulo `calculator`, la bitácora
`guardrail_log` y cómo correr los tests.

---

## 1. Mapa de archivos (estado real, 2026-08-07)

```
src/lib/guardrail/
  run.ts             ← runGuardrail(): orquesta extracción → validación → política
  index.ts           ← barrel, reexporta run.ts + el resto
  extract.ts         ← hechos verificados del mensaje del usuario
  validate.ts        ← grounding de cada cifra de la respuesta (incl. tercera vía)
  policy.ts          ← bloqueo, reescritura, guardrail_log
  schema.ts          ← parseo tolerante del output (Zod)
  injection.ts       ← detector de inyección de prompts
  numbers.ts         ← findNumberMentions / parseDigitAmount / dedupeOverlaps
  context.ts         ← moneda, etiqueta por proximidad, isPercent, isTimeUnit
  pipeline.ts         ← applyEnforcement(): la cadena completa (ver PIPELINE_CONTRACT.md)
  commandments.ts     ← "The Commandments": red de seguridad final
  enforcement.ts      ← ENFORCEMENT_MODE (full | minimal)
  turn-classifier.ts  ← classifyTurn(): META | FINANCIERO | MIXTO

src/lib/calculator/
  operations.ts   ← sobrante · porcentajeDe · regla503020 · fondoEmergencia
                    proyeccion · tiempoHastaMeta · ratioDeuda · loanPayment
                    interesCompuesto
  orchestrator.ts ← buildVerifiedContext() y buildScenarioContext()
  expenses.ts     ← parser de listas de gasto + detector de pegado (Truth Engine)
  scenario.ts     ← extractScenarioDelta, mergeScenario, fact_status (Truth Engine)
  tools.ts        ← puente tool-calling → ScenarioDelta

supabase/migrations/
  009_guardrail.sql            ← tabla guardrail_log + RLS
  011_response_telemetry.sql   ← auditoría completa del turno
  015_enforcement_mode.sql     ← columna enforcement_mode en response_telemetry
  019_telemetry_extraction.sql ← columnas de telemetría de extracción (Truth Engine)
```

**Corrección sobre documentación previa:** `src/lib/llm/router.ts` (LLM
Router agnóstico de proveedor, descrito como "existe pero nadie lo consume"
en versiones anteriores de `CLAUDE.md`) **no existe en `develop` hoy**. El
chat sigue consumiendo `src/lib/llm.ts` (`callLLM`, `callLLMJson`,
`callLLMWithHistory`, `callLLMWithTools`). Dominio de AG08 — no se documenta
como pendiente de cableado porque el archivo mismo no está en el árbol.

### Flujo de un turno (capas de guardarraíl propiamente dichas, dentro de `runGuardrail`)

```
mensaje del usuario
      │
      ├─► detectInjection()             señal informativa, nunca bloquea
      ├─► extractInputFacts()           → VerifiedFact[]
      ▼
respuesta del modelo
      │
      ├─► parseModelOutput()            → { consejo, structured }
      ├─► validateGrounding(consejo, hechos, cifrasCalculadas)
      │                                 → { aprobadas, bloqueadas }
      ├─► applyPolicy()                 → texto_final + logEntries + mutations
      └─► logGuardrailEvents()          → guardrail_log (best-effort)
      ▼
  texto_final
```

`runGuardrail()` es una de las piezas que `pipeline.ts::applyEnforcement()`
orquesta junto con `enforceSimulationHonesty`, `validateConsigliereOutput`,
`enforceOutputPolicy`, `ensureSubstance`, `resolveClosing` y
`assertOutputInvariants` — ver `PIPELINE_CONTRACT.md` para ese orden completo.

---

## 2. La tercera vía de cifras estándar

El validador clasifica **cada** cifra de la respuesta. Ante una cifra que el
usuario no aportó, el modelo no tiene dos vías (inventarla · callarse). Tiene
tres:

| Categoría | Qué es | Ejemplo | Resultado |
|-----------|--------|---------|-----------|
| `hecho` | Coincide con un dato del usuario (±1%, piso de 1) | usuario dijo "gano 2500" → "tus 2500" | ✅ se mantiene |
| `calculo` | Se deriva de un hecho, o la produjo el motor financiero | 2500 − 1500 → "te sobran 1000" | ✅ se mantiene |
| `concepto` | **Tercera vía**: porcentaje o regla general del dominio | "el 20% del ingreso", "de 3 a 6 meses" | ✅ se mantiene |
| *(ninguna)* | Monto absoluto sin respaldo | "gastarás unos 1800 al mes" | 🚫 **bloqueado** |

La tercera vía es la salida honesta cuando falta el dato: **enunciar la
regla, no materializarla en euros que nadie dio.** "Reserva de 3 a 6 meses de
gastos" es correcto; "tu Reserva de Imprevistos debe ser de 9.000 €" — sin
conocer sus gastos — es una alucinación.

Implementación: `validate.ts` → `isPercent()` / `isTimeUnit()` (categoría
`concepto`), coincidencia aproximada con un hecho declarado (categoría
`hecho`), coincidencia con `cifrasCalculadas`/`conceptos` del motor
financiero (categoría `calculo`). Una coincidencia exacta con el motor
financiero se aprueba **antes** de probar los multiplicadores heurísticos: el
cálculo verificado manda sobre la heurística.

---

## 3. Módulo `calculator`

Código puro, sin LLM: recibe el estado extraído del usuario y produce cifras
verificadas para que el guardarraíl las use como fuente de `calculo`.

- **`operations.ts`** — las operaciones financieras atómicas (sobrante,
  regla 50/30/20, fondo de emergencia, proyección, tiempo hasta meta, ratio
  de deuda, cuota de crédito, interés compuesto). Cada una devuelve
  `CalcValor` o `CalcError` — nunca lanza.
- **`orchestrator.ts`** — `buildVerifiedContext(userMessage)` construye el
  bloque de contexto verificado a partir de un solo mensaje;
  `buildScenarioContext(...)` construye el contexto sobre el `ScenarioState`
  acumulado entre turnos (Truth Engine). Ambos alimentan
  `cifrasCalculadas`/`conceptos` que consume `validateGrounding`.
- **`expenses.ts` / `scenario.ts`** — parser de listas de gasto, detector de
  ítems sospechosos de pegado (§5.2 de `CONTRATO_TRUTH_ENGINE.md`), máquina
  de estados `fact_status`. Dominio del sprint Truth Engine.

---

## 4. Tabla `guardrail_log`

`supabase/migrations/009_guardrail.sql`. **Solo metadatos.**

| Columna | Tipo | Notas |
|---------|------|-------|
| `id` | `uuid` | PK, `gen_random_uuid()` |
| `user_id` | `uuid` | FK `auth.users`, `ON DELETE CASCADE` |
| `blocked_value` | `numeric` | valor numérico bloqueado |
| `blocked_text` | `text` | literal exacto (`"1500"`) |
| `reason` | `text` | motivo de la regla |
| `question_hash` | `text` | SHA-256 truncado a 16 chars |
| `created_at` | `timestamptz` | `now()` |

### Privacidad — no negociable

- **Nunca** se almacena el mensaje del usuario ni la respuesta del modelo.
- La pregunta se referencia por `question_hash` (`hashQuestion()`, Web
  Crypto, edge-safe).
- **RLS activa**: `auth.uid() = user_id` en `USING` y `WITH CHECK`.
- `logGuardrailEvents()` es **best-effort**: un fallo de la bitácora nunca
  tumba el chat.

La auditoría **completa** del turno (texto crudo, mutaciones, modo de
enforcement) vive en `response_telemetry` (migraciones 011/012/015/019), no
en `guardrail_log`. Ver `docs/PIPELINE_CONTRACT.md` y las reglas de purga en
`src/lib/telemetry-purge.ts`.

---

## 5. Cómo correr los tests

Node puro vía `tsx`, sin framework. Scripts de `package.json`:

```bash
npm test                  # ica · portugal · transactions · language · validator · route.static · persistence
npm run test:guardrail    # guardrail · numbers · injection · turn-classifier · commandments · enforcement · plan-fantasma · persona-factibilidad
npm run test:calculator   # operations · orchestrator · expenses · scenario · tools
npm run test:regression   # scripts/regression-harness.ts (harness end-to-end sobre fixtures)
npm run test:e2e          # scripts/e2e-turn.ts (requiere credenciales Supabase reales)
```

Un archivo suelto:

```bash
npx tsx src/lib/guardrail/guardrail.test.ts
```

---

## 6. Límites conocidos

- **Convención numérica es/LatAm** (`numbers.ts`): el punto es separador de
  miles y la coma decimal. `"1.200,50"` → `1200.5`. Un usuario que escriba en
  convención anglosajona (`"1,200.50"`) será malinterpretado.
- **`schema.ts` importa `zod`, que sigue sin estar declarado en
  `package.json`.** Se resuelve como dependencia transitiva de `openai`
  (`^3.25 || ^4.0` en el lock). Si `openai` deja de arrastrarlo, el build
  rompe. Pendiente: declararlo explícitamente.
- **`detectInjection()` es informativo, nunca bloquea por sí solo.** Es
  deliberadamente conservador: prefiere no marcar consultas financieras
  normales antes que atrapar todo intento.
- **Streaming.** El guardarraíl necesita la respuesta **completa** antes de
  validarla, así que el chat bufferiza y la UX token-a-token queda aparcada
  (rama `feature/streaming-buffer`, local, sin subir).
