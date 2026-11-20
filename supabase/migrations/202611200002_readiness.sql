-- Forward-only production safeguards. Keep the original financial migration immutable.
-- Limits live at the insert boundary, including directly invoked authenticated RPCs.
create index beter_bet_owner_time on public.beter_bets(owner_id,created_at);
create index beter_quote_owner_time on public.beter_quotes(owner_id,created_at);
create index beter_quote_expiry on public.beter_quotes(expires_at,id);
create index beter_job_retention on public.beter_jobs(created_at,id);
create function public.beter_write_quota() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_recent bigint; v_daily bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('quota:'||new.owner_id::text,0));
  if tg_table_name='beter_portfolios' then
    select count(*) filter(where created_at>=clock_timestamp()-interval '1 hour'),count(*)
      into v_recent,v_daily from public.beter_portfolios where owner_id=new.owner_id and created_at>=clock_timestamp()-interval '24 hours';
    if v_recent>=5 or v_daily>=20 then raise exception 'BETER_RATE_LIMITED: portfolio creation limit reached'; end if;
  elsif tg_table_name='beter_quotes' then
    select count(*) filter(where created_at>=clock_timestamp()-interval '1 minute'),count(*)
      into v_recent,v_daily from public.beter_quotes where owner_id=new.owner_id and created_at>=clock_timestamp()-interval '24 hours';
    if v_recent>=30 or v_daily>=500 then raise exception 'BETER_RATE_LIMITED: quote limit reached'; end if;
  elsif tg_table_name='beter_bets' then
    select count(*) filter(where created_at>=clock_timestamp()-interval '1 minute'),count(*)
      into v_recent,v_daily from public.beter_bets where owner_id=new.owner_id and created_at>=clock_timestamp()-interval '24 hours';
    if v_recent>=30 or v_daily>=300 then raise exception 'BETER_RATE_LIMITED: bet placement limit reached'; end if;
  end if;
  return new;
end $$;
revoke all on function public.beter_write_quota() from public,anon,authenticated,service_role;
create trigger beter_portfolio_quota before insert on public.beter_portfolios for each row execute function public.beter_write_quota();
create trigger beter_quote_quota before insert on public.beter_quotes for each row execute function public.beter_write_quota();
create trigger beter_bet_quota before insert on public.beter_bets for each row execute function public.beter_write_quota();

create table public.beter_event_controls (
  event_id text primary key references public.beter_events(id),
  automation_held boolean not null default false,
  updated_at timestamptz not null default clock_timestamp()
);
create table public.beter_operator_audit (
  id uuid primary key default gen_random_uuid(),
  event_id text not null references public.beter_events(id),
  action text not null check(action in ('resolve','resume')),
  result_version text,
  operator_name text not null check(char_length(operator_name) between 2 and 120),
  reason text not null check(char_length(reason) between 10 and 2000),
  evidence jsonb not null default '{}',
  created_at timestamptz not null default clock_timestamp()
);
create unique index beter_operator_resolution_version on public.beter_operator_audit(event_id,result_version) where action='resolve';
create trigger beter_operator_audit_immutable before update or delete on public.beter_operator_audit for each row execute function public.beter_immutable_record();
alter table public.beter_event_controls enable row level security;
alter table public.beter_operator_audit enable row level security;
revoke all on public.beter_event_controls,public.beter_operator_audit from public,anon,authenticated;
grant select on public.beter_event_controls,public.beter_operator_audit to service_role;

-- A worker may already have read a candidate when an operator takes control.
-- Enforce the hold under the same event lock used by result application.
alter function public.beter_settle(text,jsonb,text,jsonb) rename to beter_apply_result;
revoke all on function public.beter_apply_result(text,jsonb,text,jsonb) from public,anon,authenticated,service_role;
create function public.beter_settle(p_event_id text,p_outcomes jsonb,p_result_version text,p_evidence jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('result:'||p_event_id,0));
  if exists(select 1 from public.beter_event_controls where event_id=p_event_id and automation_held) then raise exception 'event automation is held for operator review'; end if;
  return public.beter_apply_result(p_event_id,p_outcomes,p_result_version,p_evidence);
end $$;
revoke all on function public.beter_settle(text,jsonb,text,jsonb) from public,anon,authenticated;
grant execute on function public.beter_settle(text,jsonb,text,jsonb) to service_role;

create function public.beter_resolve_event(p_event_id text,p_outcomes jsonb,p_result_version text,p_evidence jsonb,p_operator text,p_reason text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_result jsonb; v_existing public.beter_operator_audit; v_version text;
begin
  if p_operator is null or char_length(trim(p_operator)) not between 2 and 120 then raise exception 'operator identity is required'; end if;
  if p_reason is null or char_length(trim(p_reason)) not between 10 and 2000 then raise exception 'operator reason must contain 10 to 2000 characters'; end if;
  if p_result_version is null or char_length(trim(p_result_version)) not between 1 and 240 then raise exception 'valid operator result version is required'; end if;
  if jsonb_typeof(p_evidence) is distinct from 'object' or coalesce(trim(p_evidence->>'source'),'')='' or
    coalesce(nullif(p_evidence->>'last_update',''),nullif(p_evidence->>'updated_at','')) is null then raise exception 'attributable source evidence and timestamp are required'; end if;
  v_version:='operator:'||trim(p_result_version);
  perform pg_advisory_xact_lock(hashtextextended('result:'||p_event_id,0));
  if jsonb_typeof(p_outcomes) is distinct from 'array' or jsonb_array_length(p_outcomes)=0 or
    jsonb_array_length(p_outcomes)<>(select count(*) from public.beter_bets where event_id=p_event_id) or
    exists(select 1 from public.beter_bets b where b.event_id=p_event_id and not exists(select 1 from jsonb_array_elements(p_outcomes) o where o->>'bet_id'=b.id::text)) then
    raise exception 'operator outcomes must identify all accepted bets for the event';
  end if;
  select * into v_existing from public.beter_operator_audit where event_id=p_event_id and action='resolve' and result_version=v_version;
  if found and (v_existing.operator_name<>trim(p_operator) or v_existing.reason<>trim(p_reason) or v_existing.evidence<>p_evidence) then
    raise exception 'operator result version already exists with different audit evidence';
  end if;
  v_result:=public.beter_apply_result(p_event_id,p_outcomes,v_version,p_evidence);
  if coalesce((v_result->>'stale')::boolean,false) then raise exception 'operator evidence is older than the accepted result'; end if;
  insert into public.beter_operator_audit(event_id,action,result_version,operator_name,reason,evidence)
    values(p_event_id,'resolve',v_version,trim(p_operator),trim(p_reason),p_evidence) on conflict(event_id,result_version) where action='resolve' do nothing;
  insert into public.beter_event_controls(event_id,automation_held) values(p_event_id,true)
    on conflict(event_id) do update set automation_held=true,updated_at=clock_timestamp();
  if v_existing.id is null then
    perform public.beter_job_record('review:'||case when char_length(p_event_id)<=90 then p_event_id else encode(sha256(convert_to(p_event_id,'UTF8')),'hex') end,true,
      jsonb_build_object('reason','Resolved with audited operator evidence.','resultVersion',v_version));
  end if;
  return v_result||jsonb_build_object('automationHeld',true);
end $$;
create function public.beter_resume_event(p_event_id text,p_operator text,p_reason text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if p_operator is null or char_length(trim(p_operator)) not between 2 and 120 then raise exception 'operator identity is required'; end if;
  if p_reason is null or char_length(trim(p_reason)) not between 10 and 2000 then raise exception 'operator reason must contain 10 to 2000 characters'; end if;
  perform pg_advisory_xact_lock(hashtextextended('result:'||p_event_id,0));
  if not exists(select 1 from public.beter_events where id=p_event_id) then raise exception 'event not found'; end if;
  insert into public.beter_operator_audit(event_id,action,operator_name,reason) values(p_event_id,'resume',trim(p_operator),trim(p_reason));
  insert into public.beter_event_controls(event_id,automation_held) values(p_event_id,false)
    on conflict(event_id) do update set automation_held=false,updated_at=clock_timestamp();
  return jsonb_build_object('automationHeld',false);
end $$;

-- Keyset pages avoid dropping later events when a pass reaches its event budget.
-- Include all accepted bets for selected events, keeping repeated result-version
-- outcomes stable even when an unchanged bet passes the correction window.
create function public.beter_settlement_batch(p_after text default null,p_limit integer default 100) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_events jsonb; v_next text;
begin
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'settlement batch limit must be between 1 and 100'; end if;
  if p_after is not null and char_length(p_after)>500 then raise exception 'invalid settlement batch cursor'; end if;
  select coalesce(jsonb_agg(to_jsonb(e)||jsonb_build_object('bets',(
    select jsonb_agg(to_jsonb(b) order by b.created_at,b.id) from public.beter_bets b where b.event_id=e.id
  )) order by e.id),'[]'::jsonb) into v_events from (
    select e.* from public.beter_events e where (p_after is null or e.id>p_after)
      and not exists(select 1 from public.beter_event_controls c where c.event_id=e.id and c.automation_held)
      and exists(select 1 from public.beter_bets b where b.event_id=e.id and (b.status='open' or b.settled_at>clock_timestamp()-interval '72 hours'))
    order by e.id limit p_limit
  ) e;
  if jsonb_array_length(v_events)=p_limit then v_next:=v_events->(p_limit-1)->>'id'; end if;
  return jsonb_build_object('events',v_events,'nextCursor',v_next);
end $$;

create function public.beter_history(p_portfolio_id uuid,p_before uuid default null,p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_user uuid:=auth.uid(); v_before public.beter_bets; v_bets jsonb; v_next uuid;
begin
  if v_user is null then raise exception 'authentication required'; end if;
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'history limit must be between 1 and 100'; end if;
  if not exists(select 1 from public.beter_portfolios where id=p_portfolio_id and owner_id=v_user) then raise exception 'portfolio not found'; end if;
  if p_before is not null then
    select * into v_before from public.beter_bets where id=p_before and portfolio_id=p_portfolio_id and owner_id=v_user;
    if not found then raise exception 'history cursor not found'; end if;
  end if;
  select coalesce(jsonb_agg(to_jsonb(b) order by b.created_at desc,b.id desc),'[]'::jsonb) into v_bets from (
    select * from public.beter_bets where portfolio_id=p_portfolio_id and owner_id=v_user
      and (p_before is null or (created_at,id)<(v_before.created_at,v_before.id)) order by created_at desc,id desc limit p_limit+1
  ) b;
  if jsonb_array_length(v_bets)>p_limit then v_bets:=v_bets-p_limit;v_next:=(v_bets->(p_limit-1)->>'id')::uuid;end if;
  return jsonb_build_object('bets',v_bets,'nextCursor',v_next);
end $$;

create function public.beter_maintenance(p_batch_size integer default 1000) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_quotes integer; v_jobs integer;
begin
  if p_batch_size is null or p_batch_size not between 1 and 10000 then raise exception 'maintenance batch limit must be between 1 and 10000'; end if;
  delete from public.beter_quotes q where q.id in (
    select old.id from public.beter_quotes old where old.expires_at<clock_timestamp()-interval '24 hours'
      and not exists(select 1 from public.beter_bets b where b.quote_id=old.id)
    order by old.expires_at,old.id limit p_batch_size for update skip locked
  );get diagnostics v_quotes=row_count;
  delete from public.beter_jobs j where j.id in (
    select old.id from public.beter_jobs old where old.created_at<clock_timestamp()-interval '30 days'
      and (old.name not in ('pipeline','odds:basketball_nba','odds:americanfootball_nfl','odds:icehockey_nhl','results:basketball_nba','results:americanfootball_nfl','results:icehockey_nhl')
        or exists(select 1 from public.beter_jobs newer where newer.name=old.name and (newer.created_at,newer.id)>(old.created_at,old.id)))
      and (old.name not like 'review:%' or old.ok or exists(select 1 from public.beter_jobs newer where newer.name=old.name and (newer.created_at,newer.id)>(old.created_at,old.id)))
    order by old.created_at,old.id limit p_batch_size for update skip locked
  );get diagnostics v_jobs=row_count;
  return jsonb_build_object('quotesDeleted',v_quotes,'jobsDeleted',v_jobs);
end $$;

create or replace function public.beter_health() returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
  select jsonb_build_object(
    'schema_version',2,
    'ledger_mismatches',(select count(*) from public.beter_portfolios p where p.balance_cents<>coalesce((select sum(l.amount_cents) from public.beter_ledger l where l.portfolio_id=p.id),0)),
    'open_bets',(select count(*) from public.beter_bets where status='open'),
    'unsettled_bets',(select count(*) from public.beter_bets b join public.beter_events e on e.id=b.event_id where b.status='open' and e.starts_at<clock_timestamp()-interval '6 hours'),
    'operator_holds',(select count(*) from public.beter_event_controls where automation_held),
    'jobs',coalesce((select jsonb_agg(to_jsonb(j)) from(select distinct on(name) * from public.beter_jobs order by name,created_at desc,id desc) j),'[]'::jsonb))
$$;
revoke all on function public.beter_resolve_event(text,jsonb,text,jsonb,text,text),public.beter_resume_event(text,text,text),public.beter_settlement_batch(text,integer),public.beter_history(uuid,uuid,integer),public.beter_maintenance(integer) from public,anon,authenticated;
grant execute on function public.beter_history(uuid,uuid,integer) to authenticated;
grant execute on function public.beter_resolve_event(text,jsonb,text,jsonb,text,text),public.beter_resume_event(text,text,text),public.beter_settlement_batch(text,integer),public.beter_maintenance(integer) to service_role;
