-- migración 014: renombra los niveles ICA a nomenclatura de CONOCIMIENTO (AG06).
--
-- ⚠️  ADVERTENCIA DE ORDEN — LEER ANTES DE EJECUTAR ⚠️
-- Esta migración se ejecuta SOLO DESPUÉS de desplegar el código de la Tarea 1
-- (getICALevel() en src/lib/ica.ts devolviendo 'conocimiento_inicial' /
-- 'conocimiento_parcial' / 'conocimiento_pleno'). Si se ejecuta ANTES de ese
-- despliegue, el CHECK constraint de la parte (b) rechazará todos los INSERT
-- que la app en producción siga escribiendo con los literales viejos
-- ('ceguera', 'vision', 'soberania', 'dominio'), rompiendo la escritura de
-- ica_history en caliente.
--
-- Contexto (ver docs/informes/AUDITORIA_AG06_ica_idf.md):
--   - Decisión de Luis: los 3 niveles ICA pasan de nomenclatura de "control"
--     (ceguera/visión/dominio) a nomenclatura de "conocimiento" — evita
--     solapar terminología con IDF (que sí habla de dominio/control sobre la
--     meta) y evita cualquier residuo de 'soberania'.
--   - La migración 013 (backfill 'soberania' → 'dominio') fue escrita pero
--     verificado en BD real (2026-07-28) que Luis NO la había ejecutado
--     todavía: ica_history seguía con 'soberania' (58), 'vision' (22),
--     'ceguera' (22), 0 filas en 'dominio'. Por eso el backfill de abajo
--     cubre los CUATRO literales heredados posibles, sin asumir si 013 corrió.
--   - ica_history.level no tenía CHECK constraint (confirmado en la auditoría
--     AG06 anterior) — esta migración añade uno para que la deriva de
--     literales no vuelva a ocurrir.
--
-- IDEMPOTENTE: el UPDATE solo toca filas con literales viejos (no-op en
-- reejecuciones); el CHECK se añade solo si no existe ya.

-- (a) backfill — cubre los 4 literales heredados posibles, ejecute o no 013 antes:
update public.ica_history
set level = 'conocimiento_inicial'
where level = 'ceguera';

update public.ica_history
set level = 'conocimiento_parcial'
where level = 'vision';

update public.ica_history
set level = 'conocimiento_pleno'
where level in ('soberania', 'dominio');

-- (b) CHECK constraint — solo después del backfill de (a), y solo si no existe ya.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'ica_history_level_check'
      and conrelid = 'public.ica_history'::regclass
  ) then
    alter table public.ica_history
      add constraint ica_history_level_check
      check (level in ('conocimiento_inicial', 'conocimiento_parcial', 'conocimiento_pleno'));
  end if;
end $$;
