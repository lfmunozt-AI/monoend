# Estado actual — Truth Engine

**Actualizado:** 2026-08-07 (AG05)
**Referencia de comportamiento:** `docs/CONTRATO_TRUTH_ENGINE.md` (ver §16 Enmiendas)

---

## Rama `develop`

- **Tanda 1 mergeada.**
  - PR #45 — informes de la revisión adversarial (AG01).
  - PR #46 — correcciones de AG08: parser restaurado, reconciliación cross-turno
    revertida (no era de esta tanda), detector de pegado recalibrado a 50×,
    eco sin plantilla, migración `019_telemetry_extraction.sql` incluida.
- **Migraciones ejecutadas hasta `019_telemetry_extraction.sql`** (ver
  `supabase/migrations/`).

## `agent/08`

- **En corrección del bloqueante de spans**: la pérdida de partidas por
  fusión de fragmentos de nombre al borrar el token reclamado por un patrón
  declarativo (invariante **V13**, `docs/CONTRATO_TRUTH_ENGINE.md` §16 E2).

## Tanda 2 — pendiente

- **Reconciliación cross-turno (Gate G1c)**: `reconcile(previousTruth,
  currentDelta)` bidireccional (T1 agregado → T2 detalle, y a la inversa),
  materialidad, escape a `ASSUMED` tras dos intentos. Ninguna parte de esto
  está implementada todavía — confirmado explícitamente en
  `docs/informes/CORRECCIONES_AG08_tanda1_truth_engine.md` §0.
- Mecanismo de reclamación (V13) para resolver la deuda aceptada de §12
  (`meta.monto` capturando el ingreso).

## Próximos pasos

1. AG08 cierra el bloqueante de spans en `agent/08` y reporta Fase 4.
2. Revisión por agente distinto (AG01), obligatoria desde la enmienda E6.
3. Arranque de tanda 2 (G1c) sobre `develop` una vez la corrección de spans
   esté mergeada.

## Nota de proceso — reconstrucción de `CLAUDE.md` (esta entrega)

Al arrancar esta sesión, `origin/develop` tenía `CLAUDE.md` fechado
2026-05-19 — dos meses y medio desatrasado. Un commit local de AG05
(`5014d58`, 8 de julio, "documentación integral sprint — ADN, términos,
guardrail, proceso") nunca se pusheó a `origin/agent/05` y quedó huérfano al
ejecutar el reset del protocolo estándar (`git reset --hard
origin/develop`). Antes de descartarlo se respaldó en dos ramas remotas:

- `backup/ag05-docs-5014d58` — el commit huérfano completo (CLAUDE.md v2.1,
  PROJECT_LOG, `docs/GUARDRAIL.md` v1, informes).
- `backup/ag05-mayo` — los 4 commits de finales de mayo que tenía
  `origin/agent/05` y que el `--force-with-lease` de esta entrega sobrescribe
  (contenido ya reflejado en `develop` vía merges anteriores).

El bloque `---ADN---` y la terminología ("Reserva de Imprevistos", "The
Consigliere", ICA, prohibición absoluta de "soberanía/soberano") se
**re-aplicaron manualmente** sobre el `CLAUDE.md` actual de `develop` — no se
hizo cherry-pick de `5014d58`, porque el archivo evolucionó de forma
incompatible en dos meses. `docs/GUARDRAIL.md` se **reescribió** (no se
reaplicó tal cual) porque la arquitectura de guardarraíl cambió de fondo
desde julio: `runGuardrail` ya no vive en `index.ts` sino en `run.ts` y se
orquesta desde `pipeline.ts::applyEnforcement()` (ver
`docs/PIPELINE_CONTRACT.md`); `src/lib/llm/router.ts` (LLM Router agnóstico,
documentado como "existe pero no cableado") **ya no está en el árbol** —
dominio de AG08, se documenta como ausente, no como pendiente.
