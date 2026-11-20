-- Private, durable fixed-window authentication budgets shared by all API instances.
-- Bucket keys are server-HMACs; addresses, emails and credentials are never stored.
create table public.beter_auth_buckets (
  kind text not null check(kind in ('identity','recovery','source','global')),
  key_hash text not null check(key_hash ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz not null default clock_timestamp(),
  attempts integer not null check(attempts>0),
  primary key(kind,key_hash)
);
create index beter_auth_bucket_age on public.beter_auth_buckets(window_started_at);
alter table public.beter_auth_buckets enable row level security;
revoke all on public.beter_auth_buckets from public,anon,authenticated,service_role;

create function public.beter_auth_limit(p_buckets jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_bucket jsonb; v_limit integer; v_seconds integer; v_count integer; v_started timestamptz;
  v_allowed boolean:=true; v_retry integer:=0;
begin
  if jsonb_typeof(p_buckets) is distinct from 'array' or jsonb_array_length(p_buckets) not between 1 and 4 then raise exception 'invalid authentication bucket batch'; end if;
  for v_bucket in select value from jsonb_array_elements(p_buckets) loop
    if jsonb_typeof(v_bucket) is distinct from 'object' or coalesce(v_bucket->>'kind','') not in ('identity','recovery','source','global') or coalesce(v_bucket->>'key','') !~ '^[a-f0-9]{64}$' then raise exception 'invalid authentication bucket'; end if;
  end loop;
  if (select count(distinct value->>'kind') from jsonb_array_elements(p_buckets))<>jsonb_array_length(p_buckets) then raise exception 'duplicate authentication bucket kinds'; end if;
  -- Every caller locks the same order, including concurrently denied requests.
  for v_bucket in select value from jsonb_array_elements(p_buckets) order by case value->>'kind' when 'global' then 0 when 'source' then 1 else 2 end,value->>'kind',value->>'key' loop
    v_seconds:=case v_bucket->>'kind' when 'identity' then 600 when 'recovery' then 3600 else 60 end;
    v_limit:=case v_bucket->>'kind' when 'identity' then 10 when 'recovery' then 3 when 'source' then 30 else 600 end;
    insert into public.beter_auth_buckets(kind,key_hash,attempts) values(v_bucket->>'kind',v_bucket->>'key',1)
    on conflict(kind,key_hash) do update set
      attempts=case when beter_auth_buckets.window_started_at<=clock_timestamp()-make_interval(secs=>v_seconds) then 1 else least(beter_auth_buckets.attempts,2147483646)+1 end,
      window_started_at=case when beter_auth_buckets.window_started_at<=clock_timestamp()-make_interval(secs=>v_seconds) then clock_timestamp() else beter_auth_buckets.window_started_at end
    returning attempts,window_started_at into v_count,v_started;
    if v_count>v_limit then
      v_allowed:=false;v_retry:=greatest(1,ceil(extract(epoch from v_started+make_interval(secs=>v_seconds)-clock_timestamp()))::integer);
      return jsonb_build_object('allowed',false,'retry_after_seconds',v_retry);
    end if;
  end loop;
  return jsonb_build_object('allowed',v_allowed,'retry_after_seconds',v_retry);
end $$;
revoke all on function public.beter_auth_limit(jsonb) from public,anon,authenticated;
grant execute on function public.beter_auth_limit(jsonb) to service_role;

-- Extend maintenance without rewriting the earlier migration or touching audit records.
alter function public.beter_maintenance(integer) rename to beter_maintenance_v2;
revoke all on function public.beter_maintenance_v2(integer) from public,anon,authenticated,service_role;
create function public.beter_maintenance(p_batch_size integer default 1000) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_result jsonb; v_deleted integer;
begin
  v_result:=public.beter_maintenance_v2(p_batch_size);
  delete from public.beter_auth_buckets where (kind,key_hash) in (
    select kind,key_hash from public.beter_auth_buckets where window_started_at<clock_timestamp()-interval '24 hours'
    order by window_started_at limit p_batch_size for update skip locked
  );get diagnostics v_deleted=row_count;
  return v_result||jsonb_build_object('authBucketsDeleted',v_deleted);
end $$;
revoke all on function public.beter_maintenance(integer) from public,anon,authenticated;
grant execute on function public.beter_maintenance(integer) to service_role;
alter function public.beter_health() rename to beter_health_v2;
revoke all on function public.beter_health_v2() from public,anon,authenticated,service_role;
create function public.beter_health() returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
  select public.beter_health_v2()||jsonb_build_object('schema_version',3)
$$;
revoke all on function public.beter_health() from public,anon,authenticated;
grant execute on function public.beter_health() to service_role;
