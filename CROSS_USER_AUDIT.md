# Cross-User RLS Audit — AG03 Zero-Trust

**Generado:** 2026-05-26T22:42:06.996Z
**Proyecto Supabase:** `jmbzjcrgxetqfkqopfgr` (staging)
**Usuario A:** `test_a@audit.andgcore.test` — `55888152-d1af-42f1-a0f3-9626129c4688`
**Usuario B:** `test_b@audit.andgcore.test` — `3e68e392-79df-4c53-b12c-e221a03085d4`

## Metodología

Para cada tabla con `user_id`, se siembra una fila por usuario vía service role.
Luego, autenticado como A, se intenta SELECT/UPDATE/DELETE contra la fila de B.
La verificación final del estado de la fila se hace vía service role (que
bypassea RLS), evitando así falsos PASS por RLS filtrando la respuesta del
propio attacker. Cuando service_role carece de GRANT (ver §Hallazgos secundarios),
la verificación se hace vía la sesión autenticada de la víctima (que ve sus
propios datos por RLS).

Criterio de PASS:

- `SELECT cross-user` = 0 filas leídas
- `UPDATE cross-user` = fila víctima sin cambios tras el intento
- `DELETE cross-user` = fila víctima sigue existiendo tras el intento

## Resumen

| Tabla | RLS Activa | SELECT cross-user | UPDATE cross-user | DELETE cross-user | Veredicto |
|-------|------------|-------------------|-------------------|-------------------|-----------|
| profiles | sí | 0 leaks | bloqueado | bloqueado | PASS |
| fiscal_profiles | sí | 0 leaks | bloqueado | bloqueado | PASS |
| transactions | sí | 0 leaks | bloqueado | bloqueado | PASS |
| ica_history | sí | 0 leaks | bloqueado | bloqueado | PASS |
| conversations | sí | 0 leaks | bloqueado | bloqueado | PASS |
| messages | sí | 0 leaks | bloqueado | bloqueado | PASS |
| embeddings | sí | 0 leaks | bloqueado | bloqueado | PASS |
| subscriptions | sí | 0 leaks | bloqueado | bloqueado | PASS |
| documents | sí | 0 leaks | bloqueado | bloqueado | PASS |
| audit_logs | sí | 0 leaks | bloqueado | bloqueado | PASS |
| consent_records | sí | 0 leaks | bloqueado | bloqueado | PASS |
| goals | sí | 0 leaks | bloqueado | bloqueado | PASS |

## Hallazgos críticos

Ninguno. Todas las tablas con `user_id` aíslan correctamente a usuarios distintos.

## Hallazgos secundarios — grants de service_role

Durante la siembra se detectaron tablas donde el rol `service_role` carece
de privilegios DML/SELECT, lo que rompe el patrón habitual de Supabase
(service_role bypassea RLS para tareas de servidor: webhooks, jobs, admin).

| Tabla | service_role tiene | Falta | Impacto |
|-------|--------------------|-------|---------|
| `documents` | REFERENCES, TRIGGER, TRUNCATE | SELECT, INSERT, UPDATE, DELETE | API server-side no puede leer ni escribir documentos del usuario |
| `goals` | REFERENCES, TRIGGER, TRUNCATE | SELECT, INSERT, UPDATE, DELETE | Jobs server-side no pueden gestionar metas (motor IDF en curso por AG06) |
| `consent_records` | INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE | DELETE | GDPR delete job no puede limpiar registros de consentimiento |

Esto NO es un FAIL de RLS cross-user (ningún usuario ve datos ajenos), pero
sí un riesgo operativo: las APIs server-side actuales o futuras que usen el
service role van a fallar al tocar estas tablas. Revisar con AG01 antes de
lanzar migraciones que añadan los `GRANT ... TO service_role` correspondientes.

## Tablas sin user_id (cross-user no aplica)

- `supported_languages` — Tabla de referencia pública. Sin columna user_id. SELECT abierto a todos (esperado).
- `behavioral_patterns` — Datos anonimizados sin user_id. Política SELECT con qual=false (bloqueo total a usuarios autenticados).

## Notas por tabla

- `profiles`: Fila auto-creada por trigger `on_auth_user_created`. Sin política DELETE (esperado).
- `ica_history`: Solo políticas SELECT + INSERT. UPDATE/DELETE bloqueados por ausencia de política.
- `subscriptions`: Fila auto-creada por trigger. Solo política SELECT — UPDATE/DELETE bloqueados por ausencia de política.
- `documents`: service_role sin GRANT DML/SELECT — seed y verificación vía sesión del usuario.
- `audit_logs`: Solo política SELECT propia. INSERT/UPDATE/DELETE bloqueados.
- `consent_records`: Solo política SELECT. Escritura via service role. service_role sin DELETE — seed idempotente.
- `goals`: service_role sin GRANT DML/SELECT — seed y verificación vía sesión del usuario.

## Reproducir

```bash
npx tsx scripts/cross-user-audit.ts
```

Usuarios `test_a@audit.andgcore.test` y `test_b@audit.andgcore.test` quedan en BD
para próximas auditorías (idempotente).
