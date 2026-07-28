-- migración 013: erradica el literal 'soberania' de public.ica_history.level (AG06).
--
-- "Soberanía" es término PROHIBIDO en el proyecto (CLAUDE.md, REGLAS
-- ABSOLUTAS 6). `getICALevel()` en src/lib/ica.ts devolvía 'soberania' para
-- score > 70; el código de aplicación ya se corrigió para devolver 'dominio'
-- (mismo commit). Esta migración hace el backfill del histórico ya escrito
-- en BD para que quede consistente con el nuevo literal.
--
-- Verificado antes de escribir esta migración (2026-07-27):
--   - public.ica_history: 102 filas · niveles 'soberania' (58), 'vision' (22),
--     'ceguera' (22).
--   - ica_history.level NO tiene CHECK constraint — el UPDATE no requiere
--     tocar el esquema.
--   - Ninguna función/trigger de Postgres vivo en la BD contiene el string
--     'soberania' (fn_ica_level() de 005_ica_trigger.sql nunca llegó a
--     desplegarse: no existe trigger activo sobre ica_history en producción;
--     el nivel se inserta siempre desde la capa de aplicación vía
--     getICALevel()). Ver docs/informes/AUDITORIA_AG06_ica_idf.md — hallazgo
--     crítico sobre esta discrepancia con lo documentado en CLAUDE.md.
--
-- IDEMPOTENTE: el WHERE limita el UPDATE a filas con el valor viejo; una
-- segunda ejecución no afecta ninguna fila (esperado: 58 filas la primera
-- vez, 0 filas en re-ejecuciones).

update public.ica_history
set level = 'dominio'
where level = 'soberania';
