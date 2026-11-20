-- Retain the financial maintenance contract and bound private authentication data.
alter function public.beter_maintenance(integer) rename to beter_application_maintenance;
revoke all on function public.beter_application_maintenance(integer) from public,anon,authenticated,service_role,beter_runtime;
create function public.beter_maintenance(p_batch_size integer default 1000) returns jsonb
language sql security definer set search_path=public,auth,pg_temp as $$
  select public.beter_application_maintenance(p_batch_size)||auth.beter_session_prune(p_batch_size)
$$;
revoke all on function public.beter_maintenance(integer) from public,anon,authenticated,beter_runtime;
grant execute on function public.beter_maintenance(integer) to service_role;
-- The runtime never owns schema objects or inherits privileges. Each operation
-- explicitly selects the verified caller's role inside a transaction.
alter role beter_runtime noinherit;
