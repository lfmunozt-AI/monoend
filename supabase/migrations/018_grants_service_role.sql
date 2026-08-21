-- 018_grants_service_role.sql — cierra el hallazgo de la auditoría RLS de AG03
grant select, insert, update, delete on public.goals to service_role;
grant select, insert, update, delete on public.documents to service_role;
grant select, insert, update, delete on public.behavioral_patterns to service_role;
grant select on public.supported_languages to service_role;
