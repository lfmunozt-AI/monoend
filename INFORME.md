# INFORME — AG03 Zero-Trust · Auditoría RLS cross-user

**Fecha:** 2026-05-26
**Agente:** 03 — Zero-Trust
**Worktree:** `wt-ag03-security`
**Rama:** `agent/03`
**Proyecto Supabase auditado:** `jmbzjcrgxetqfkqopfgr` (staging)

## Misión

Auditar todas las políticas RLS de las tablas existentes en `public`.
Para cada tabla con `user_id`, probar desde la sesión de un usuario A:

- SELECT cross-user contra fila de B → debe devolver 0
- UPDATE cross-user contra fila de B → debe fallar
- DELETE cross-user contra fila de B → debe fallar

Documentar resultado por tabla. **Si hay FAILs, no arreglar — solo documentar.**

## Resultado

- **12/12 tablas con `user_id` PASS** la auditoría cross-user.
- **0 hallazgos críticos** (ninguna política RLS deja filtrar datos entre usuarios).
- **2 tablas sin `user_id`** documentadas como N/A (cross-user no aplica).
- **3 hallazgos secundarios** sobre grants de `service_role` (no son fallos de RLS,
  pero rompen el patrón habitual de bypass para tareas server-side).

## Artefactos entregados

| Archivo | Propósito |
|---------|-----------|
| `scripts/cross-user-audit.ts` | Script TypeScript reproducible que crea usuarios de prueba, siembra datos por usuario, ejecuta los 3 ataques cross-user contra cada tabla y verifica el estado final vía service role (o vía sesión de la víctima cuando el service role carece de GRANT). |
| `CROSS_USER_AUDIT.md` | Reporte con la tabla resumen y los hallazgos detallados. Regenerado en cada corrida. |
| `package.json` | Añadido script `npm run audit:rls`. devDeps: `tsx`, `ws`, `@types/ws`. |

## Cómo correrlo

```bash
# Desde la raíz del proyecto (con .env.local presente):
npm install         # primera vez
npm run audit:rls
```

Variables requeridas en `.env.local`:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

El script abortar si la URL no coincide con el ref de staging permitido
(guard-rail anti-prod incorporado).

## Usuarios de prueba (quedan en BD para futuras auditorías)

| Email | UUID |
|-------|------|
| `test_a@audit.andgcore.test` | `55888152-d1af-42f1-a0f3-9626129c4688` |
| `test_b@audit.andgcore.test` | `3e68e392-79df-4c53-b12c-e221a03085d4` |

Contraseña: `AuditRLS-2026!secret` (constante en el script). El script es
idempotente: en re-runs busca usuarios existentes y limpia datos previos
antes de sembrar.

## Hallazgos secundarios — grants de `service_role`

Durante la siembra detecté tablas donde `service_role` carece de privilegios
DML/SELECT. **No es un FAIL de RLS** (los usuarios siguen sin ver datos ajenos),
pero rompe el supuesto habitual de Supabase de que `service_role` bypassea RLS
para tareas server-side (webhooks, jobs, APIs admin).

| Tabla | service_role tiene | Falta | Impacto |
|-------|--------------------|-------|---------|
| `documents` | REFERENCES, TRIGGER, TRUNCATE | SELECT, INSERT, UPDATE, DELETE | API server-side no puede tocar documentos del usuario |
| `goals` | REFERENCES, TRIGGER, TRUNCATE | SELECT, INSERT, UPDATE, DELETE | Jobs server-side no pueden gestionar metas (motor IDF en curso por AG06) |
| `consent_records` | INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE | DELETE | GDPR delete job no puede limpiar consentimientos al eliminar cuenta |

**Recomendación (no aplicada):** una futura migración debería añadir los
`GRANT SELECT, INSERT, UPDATE, DELETE ON public.<tabla> TO service_role;`
correspondientes. **No lo arreglo en este worktree** porque el alcance del
agente es solo auditar — los cambios de grants/policies los revisamos con AG01.

## Decisiones de diseño relevantes

1. **Verificación post-attack vía service role**, no vía la sesión del atacante.
   Si verificara vía A, el propio RLS escondería la respuesta del UPDATE/DELETE
   y daría un PASS falso.
2. **Fallback de verificación a sesión de la víctima** cuando `service_role`
   carece de SELECT (`documents`, `goals`). La víctima puede leer sus propios
   datos por su política RLS, así que sirve perfectamente como fuente de verdad.
3. **Guard-rail anti-prod**: el script aborta si la URL de Supabase no está en
   la allowlist (`jmbzjcrgxetqfkqopfgr`). Si en el futuro se crea un proyecto
   prod, el guard activará.
4. **No modifiqué ninguna policy RLS, GRANT, ni schema.** Solo inserté/borré
   datos de prueba bajo los dos usuarios sintéticos.

## Restricciones cumplidas

- [x] Solo staging — guard-rail incorporado.
- [x] No se modificaron políticas RLS.
- [x] Usuarios de prueba conservados.
- [x] Script corre sin errores (lint OK, tsc OK, 0 ERROR en última corrida).
- [x] Reporte claro con tabla resumen + hallazgos.

## Próximos pasos sugeridos (no aplicados)

- Coordinar con AG01: migración para añadir `GRANT ... TO service_role` en
  `documents`, `goals` (DML+SELECT) y `consent_records` (DELETE).
- Considerar añadir esta auditoría a CI cuando haya pipeline de tests E2E,
  para que regresiones en RLS se detecten en cada PR.
