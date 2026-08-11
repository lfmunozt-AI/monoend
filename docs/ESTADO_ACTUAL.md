# Estado actual — Truth Engine

**Actualizado:** 2026-08-11 (AG05)
**Referencia de comportamiento:** `docs/CONTRATO_TRUTH_ENGINE.md` (ver §16 Enmiendas, E1-E10)

---

## Rama `develop`

- **Tanda 1 mergeada** (spans/fronteras posicionales, V11-V13 → contrato E2).
- **Tanda 2 mergeada** (reconciliación cross-turno, Gate G1c):
  - PR #49 — revisión adversarial AG01 (rechazo inicial).
  - PR #50 — correcciones AG08: doble conteo de `"gasté"` (V16 parcial),
    G1c en la ruta de escape, `ASSUMED` revocable y confirmable (16/16
    formulaciones), cap de 5 versiones verificado.
  - PR #51 — `tiene_detalle_gastos` separa posesión de usabilidad + guarda de
    autoconsistencia.
  - **G1c, gate bloqueante de piloto, queda cerrado** — aprobado por AG01
    tras verificación por ejecución (`docs/informes/REVISION_AG01_tanda2_reconciliacion.md`).
- **Migraciones ejecutadas hasta `020_telemetry_conflict.sql`** (ver
  `supabase/migrations/`).

## Deuda abierta — condición antes del piloto, no bloquea merge

- **V16 generalizado (M1, `docs/CONTRATO_TRUTH_ENGINE.md` §16 E9).** El
  doble conteo está cerrado solo cuando la cifra va pegada a la palabra
  clave (`"gasté 1800:"`). Con palabra intermedia (`"mis gastos fueron
  1200:"`, `"gastamos 950 al mes:"`) el agregado se cuenta también como
  ítem y el resultado sale el doble, marcado `COMPLETE`, sin señal.
  Preexistente e idéntico en `develop` — no es regresión de la tanda 2, pero
  con usuarios reales no es un caso raro.
- **Memoria a nivel de usuario (E10).** Decisión tomada, diseño de
  implementación pendiente. Hoy `scenario_state` vive en `conversations`
  filtrado por `conversationId` — amnesia entre sesiones por diseño.

## Hoja de ruta al piloto (17 de agosto)

1. **V15 + V16 generalizado** — cerrar el M1 de doble conteo con palabra
   intermedia (§16 E9 del contrato).
2. **Memoria de usuario** — mover hechos financieros de `conversations` a
   nivel de usuario, manteniendo el estado de diálogo por conversación
   (§16 E10 del contrato).
3. **`develop` → `main`.**
4. **Dominio `monoend.andgcore.com`** — apuntar DNS (backlog 1.4 de
   `CLAUDE.md`, sigue pendiente).
5. **Separación de bases de datos Preview/Production** en Supabase.
6. **Auditoría RLS fresca** — nacieron `response_telemetry`,
   `telemetry_alerts` y `goals` con GRANTs nuevos desde la última auditoría;
   ninguna se ha revisado desde su creación.
7. **Piloto de una semana con datos reales de Luis**, desde el 17 de agosto.

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
