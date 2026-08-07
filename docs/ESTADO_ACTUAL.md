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
