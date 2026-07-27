# Ciclo de vida de `response_telemetry` — retención y GDPR

Fecha: 2026-07-27 · Autor: AG02 (Datos) · Branch: `agent/02`

`response_telemetry` (migración 011) guarda, por turno del chat,
`response_raw`/`response_final` completos — necesarios para que la revisión
nocturna (`scripts/telemetry-review.ts` / cron `telemetry-review`, AG07,
docs/ACEPTACION_FASE0.md) pueda detectar D1-D3 (compuerta G1b). Ese texto es
~3-5 KB/fila: irrelevante en las 6 semanas del piloto (10 usuarios, ~30 MB),
insostenible a escala (~2 GB/mes con 1.000 usuarios). Este documento fija el
ciclo de vida desde el día 1 para no depender de recordarlo después.

## Retención vigente

- **Texto completo (`response_raw`, `response_final`): 30 días.** Pasado ese
  plazo, `scripts/telemetry-purge.ts` (manual) / cron diario
  `telemetry-purge` (04:00 UTC — una hora después de la revisión de AG07, sin
  solaparse) ponen ambas columnas a `NULL`. Núcleo compartido:
  `src/lib/telemetry-purge.ts`.
- **Métricas: indefinido.** El resto de columnas (`latency_*`, `tokens_used`,
  `tool_call_used`, `model`, `carril`, `calculator_conceptos`,
  `scenario_missing`, `mutations`, `commandment_violations`,
  `guardrail_intervened`) NO se tocan — ninguna contiene texto libre del
  usuario ni de la respuesta, y son las que alimentan D5 (métricas) y
  cualquier análisis de tendencia del piloto (latencia, coste, tasa de
  intervención del guardarraíl) después de que el texto ya no esté.
- La purga es **idempotente**: una fila con ambas columnas ya en `NULL` no
  vuelve a aparecer en el filtro de la siguiente ejecución.

## Borrado GDPR (derecho al olvido)

- **Cascada automática:** `response_telemetry.user_id` referencia
  `auth.users(id) on delete cascade` (migración 011) — cuando una cuenta se
  borra de verdad (tras el plazo de `scheduleAccountDeletion`,
  `src/lib/gdpr.ts`), sus filas de telemetría desaparecen solas. No requiere
  acción manual.
- **Borrado manual de telemetría a petición** (un usuario pide que se elimine
  su historial de telemetría SIN borrar la cuenta, o hay que adelantarse al
  plazo de borrado programado): ejecutar contra Supabase con `service_role`,
  sustituyendo `<USER_ID>` por el UUID real:

  ```sql
  delete from public.response_telemetry where user_id = '<USER_ID>';
  ```

  o, en código (mismo patrón que el resto del proyecto — `admin` es
  `adminClient()`, `src/lib/supabase/admin.ts`):

  ```ts
  await admin.from('response_telemetry').delete().eq('user_id', userId)
  ```

  Borra la FILA completa (no solo el texto) — a diferencia de la purga
  periódica de 30 días, un borrado a petición no necesita conservar las
  métricas de ese usuario.

## Cierre del piloto

Al cerrar el piloto (6 semanas), **purga total de texto obligatoria**,
independientemente de la fecha de cada fila:

```bash
npm run telemetry:purge -- --older-than-days=0
```

(o ejecutar `purgeTelemetryText(admin, { olderThanDays: 0 })` directamente —
mismo núcleo que la purga diaria, con el corte en "ahora" en vez de "hace 30
días"). Las columnas de métricas pueden conservarse para el análisis
post-piloto; el texto de respuestas NO debe sobrevivir al piloto.

## Estrategia post-piloto (documentada, NO implementada ahora)

Fuera del alcance de esta tanda — señalada aquí y con un `TODO` en
`src/lib/telemetry.ts` como punto de extensión para cuando el piloto escale
más allá de 10 usuarios:

- **Muestreo de texto completo:** en vez de capturar `response_raw`/
  `response_final` en el 100% de los turnos, capturarlo solo en el **5-10%**
  de las respuestas (muestra aleatoria representativa para tendencias), MÁS
  el **100%** de las que tengan `commandment_violations.length > 0` o
  `guardrail_intervened === true` — son las que de verdad importan para G1b
  (una respuesta limpia sin intervención no necesita su texto conservado para
  auditar nada). El resto de columnas (métricas) se sigue capturando al 100%
  siempre — el muestreo aplica solo a las dos columnas de texto libre.
- Esto reduce el volumen de texto almacenado en proporción directa al tamaño
  de la base de usuarios, sin perder cobertura sobre los turnos que la
  compuerta G1b necesita poder auditar.
