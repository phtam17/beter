-- Return bounded presentation data while keeping financial totals authoritative.
-- No accepted bet, ledger entry, result, or balance is changed by this migration.
create index beter_bet_history_page on public.beter_bets(portfolio_id,created_at desc,id desc);
create index beter_bet_status_page on public.beter_bets(portfolio_id,status,created_at desc,id desc);

create or replace function public.beter_portfolio_json(p_id uuid) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
  with recent as (
    select * from public.beter_bets where portfolio_id=p_id order by created_at desc,id desc limit 101
  ), visible as (
    select * from recent order by created_at desc,id desc limit 100
  ), totals as (
    select count(*) as total_bets,count(*) filter(where status='open') as open_bets,
      count(*) filter(where status<>'open') as settled_bets,count(*) filter(where status='won') as wins,
      count(*) filter(where status='lost') as losses,count(*) filter(where status='void') as voids,
      coalesce(sum(stake_cents) filter(where status='open'),0) as amount_at_risk_cents,
      coalesce(sum(stake_cents),0) as total_staked_cents,
      coalesce(sum(stake_cents) filter(where status in ('won','lost')),0) as settled_staked_cents
    from public.beter_bets where portfolio_id=p_id
  ), ranked_points as (
    select id,row_number() over(order by created_at,id) as ordinal,count(*) over() as total
    from public.beter_ledger where portfolio_id=p_id and type<>'stake'
  ), point_buckets as (
    select *,case when total<=200 then ordinal else floor((ordinal-1)*199::numeric/(total-1)) end as bucket
    from ranked_points
  ), sampled_points as (
    select distinct on(bucket) id from point_buckets order by bucket,ordinal
  )
  select jsonb_build_object('id',p.id,'name',p.name,'initial_bankroll_cents',p.initial_bankroll_cents,
    'balance_cents',p.balance_cents,'created_at',p.created_at,
    'bets',coalesce((select jsonb_agg(to_jsonb(b) order by b.created_at,b.id) from visible b),'[]'::jsonb),
    'summary',(select to_jsonb(t) from totals t),
    'history_next_cursor',case when (select count(*) from recent)>100 then (select id from visible order by created_at,id limit 1) else null end,
    'ledger',coalesce((select jsonb_agg(to_jsonb(l) order by l.created_at,l.id) from public.beter_ledger l join sampled_points s on s.id=l.id),'[]'::jsonb),
    'ledger_sampled',(select count(*)>200 from ranked_points),
    'ledger_total_points',(select count(*) from ranked_points))
  from public.beter_portfolios p where p.id=p_id
$$;
-- CREATE OR REPLACE preserves the original private function's execution grants.

-- One defaulted signature keeps three-argument callers compatible without
-- ambiguous overload selection in PostgREST.
drop function public.beter_history(uuid,uuid,integer);
create function public.beter_history(p_portfolio_id uuid,p_before uuid default null,p_limit integer default 50,p_status text default null) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_user uuid:=auth.uid(); v_before public.beter_bets; v_bets jsonb; v_next uuid;
begin
  if v_user is null then raise exception 'authentication required'; end if;
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'history limit must be between 1 and 100'; end if;
  if p_status is not null and p_status not in ('open','won','lost','void') then raise exception 'invalid history status filter'; end if;
  if not exists(select 1 from public.beter_portfolios where id=p_portfolio_id and owner_id=v_user) then raise exception 'portfolio not found'; end if;
  if p_before is not null then
    select * into v_before from public.beter_bets where id=p_before and portfolio_id=p_portfolio_id and owner_id=v_user;
    if not found then raise exception 'history cursor not found'; end if;
  end if;
  select coalesce(jsonb_agg(to_jsonb(b) order by b.created_at desc,b.id desc),'[]'::jsonb) into v_bets from (
    select * from public.beter_bets where portfolio_id=p_portfolio_id and owner_id=v_user and (p_status is null or status=p_status)
      and (p_before is null or (created_at,id)<(v_before.created_at,v_before.id)) order by created_at desc,id desc limit p_limit+1
  ) b;
  if jsonb_array_length(v_bets)>p_limit then v_bets:=v_bets-p_limit;v_next:=(v_bets->(p_limit-1)->>'id')::uuid;end if;
  return jsonb_build_object('bets',v_bets,'nextCursor',v_next);
end $$;
revoke all on function public.beter_history(uuid,uuid,integer,text) from public,anon,authenticated;
grant execute on function public.beter_history(uuid,uuid,integer,text) to authenticated;

alter function public.beter_health() rename to beter_health_v3;
revoke all on function public.beter_health_v3() from public,anon,authenticated,service_role;
create function public.beter_health() returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
  select public.beter_health_v3()||jsonb_build_object('schema_version',4)
$$;
revoke all on function public.beter_health() from public,anon,authenticated;
grant execute on function public.beter_health() to service_role;
