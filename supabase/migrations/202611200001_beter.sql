-- Beter virtual-money account, quote, ledger and settlement boundary.
-- Supabase supplies auth.users, auth.uid(), anon, authenticated and service_role.
-- Every financial mutation is an atomic RPC; clients receive SELECT privileges only.

create table public.beter_portfolios (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  name text not null check (char_length(name) between 1 and 80),
  initial_bankroll_cents bigint not null default 1000000 check(initial_bankroll_cents=1000000),
  -- Corrections may reverse winnings that have already been spent. New stakes still
  -- require sufficient funds; an audited correction is allowed to expose a debt.
  balance_cents bigint not null default 1000000,
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp()
);
create unique index beter_one_active_portfolio on public.beter_portfolios(owner_id) where active;
create index beter_portfolio_owner on public.beter_portfolios(owner_id,created_at);

create table public.beter_events (
  id text primary key,
  sport text not null,
  league text not null,
  home_team text not null,
  away_team text not null,
  starts_at timestamptz not null,
  status text not null check(status in ('upcoming','inplay','completed','cancelled','postponed','unknown')),
  provider_updated_at timestamptz not null,
  fetched_at timestamptz not null
);
create table public.beter_selections (
  id text primary key,
  event_id text not null references public.beter_events(id),
  team text not null,
  market text not null check(market in ('Moneyline','Spread','Total')),
  line numeric,
  side text not null check(side in ('home','away','over','under')),
  odds integer not null check(abs(odds::bigint) between 100 and 1000000),
  bookmaker text not null,
  provider_updated_at timestamptz not null,
  fetched_at timestamptz not null,
  available boolean not null default true,
  check ((market='Moneyline' and line is null and side in ('home','away')) or
    (market='Spread' and line is not null and side in ('home','away')) or
    (market='Total' and line is not null and side in ('over','under')))
);
create index beter_selection_event on public.beter_selections(event_id);
create table public.beter_quotes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  portfolio_id uuid not null references public.beter_portfolios(id),
  selection_id text not null references public.beter_selections(id),
  selection jsonb not null,
  total_decimal_odds numeric not null,
  expires_at timestamptz not null default clock_timestamp()+interval '30 seconds',
  created_at timestamptz not null default clock_timestamp()
);
create index beter_quote_owner on public.beter_quotes(owner_id,expires_at);
create table public.beter_bets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  portfolio_id uuid not null references public.beter_portfolios(id),
  quote_id uuid not null references public.beter_quotes(id),
  request_id text not null check(char_length(request_id) between 1 and 128),
  event_id text not null references public.beter_events(id),
  selection_id text not null references public.beter_selections(id),
  selections jsonb not null,
  stake_cents bigint not null check(stake_cents>0 and stake_cents<=1000000000000),
  potential_payout_cents bigint not null check(potential_payout_cents>=stake_cents),
  payout_cents bigint not null default 0,
  odds numeric not null,
  status text not null default 'open' check(status in ('open','won','lost','void')),
  rules_version text not null default 'beter-full-game-v1',
  result_version text,
  created_at timestamptz not null default clock_timestamp(),
  settled_at timestamptz,
  unique(owner_id,request_id)
);
create index beter_bet_portfolio on public.beter_bets(portfolio_id,created_at);
create index beter_bet_event_status on public.beter_bets(event_id,status);
create table public.beter_ledger (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  portfolio_id uuid not null references public.beter_portfolios(id),
  bet_id uuid references public.beter_bets(id),
  type text not null check(type in ('grant','stake','won','lost','void','adjustment')),
  amount_cents bigint not null,
  balance_cents bigint not null,
  bankroll_cents bigint not null,
  result_version text,
  created_at timestamptz not null default clock_timestamp()
);
create index beter_ledger_portfolio on public.beter_ledger(portfolio_id,created_at);
create table public.beter_result_versions (
  id bigint generated always as identity primary key,
  event_id text not null references public.beter_events(id),
  result_version text not null,
  outcomes jsonb not null,
  evidence jsonb not null,
  provider_updated_at timestamptz,
  applied boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  unique(event_id,result_version)
);
create table public.beter_jobs (
  id bigint generated always as identity primary key,
  name text not null,
  ok boolean not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default clock_timestamp()
);
create index beter_jobs_name_time on public.beter_jobs(name,created_at desc);

create function public.beter_immutable_record() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin raise exception 'audit records are append-only'; end $$;
create trigger beter_ledger_immutable before update or delete on public.beter_ledger for each row execute function public.beter_immutable_record();
create trigger beter_results_immutable before update or delete on public.beter_result_versions for each row execute function public.beter_immutable_record();

create function public.beter_selection_json(p_id text) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('id',s.id,'event_id',e.id,'event_name',e.away_team||' at '||e.home_team,
    'sport',e.sport,'team',s.team,'market',s.market,'line',s.line,'side',s.side,'odds',s.odds,
    'bookmaker',s.bookmaker,'starts_at',e.starts_at,'provider_updated_at',s.provider_updated_at,'fetched_at',s.fetched_at)
  from public.beter_selections s join public.beter_events e on e.id=s.event_id where s.id=p_id
$$;
create function public.beter_portfolio_json(p_id uuid) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('id',p.id,'name',p.name,'initial_bankroll_cents',p.initial_bankroll_cents,
    'balance_cents',p.balance_cents,'created_at',p.created_at,
    'bets',coalesce((select jsonb_agg(to_jsonb(b) order by b.created_at,b.id) from public.beter_bets b where b.portfolio_id=p.id),'[]'::jsonb),
    'ledger',coalesce((select jsonb_agg(to_jsonb(l) order by l.created_at,l.id) from public.beter_ledger l where l.portfolio_id=p.id),'[]'::jsonb))
  from public.beter_portfolios p where p.id=p_id
$$;
create function public.beter_create_portfolio(p_name text default 'My practice') returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_user uuid:=auth.uid(); v_id uuid;
begin
  if v_user is null then raise exception 'authentication required'; end if;
  if p_name is null or char_length(trim(p_name)) not between 1 and 80 then raise exception 'portfolio name must contain 1 to 80 characters'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user::text,0));
  update public.beter_portfolios set active=false where owner_id=v_user and active;
  insert into public.beter_portfolios(owner_id,name) values(v_user,trim(p_name)) returning id into v_id;
  insert into public.beter_ledger(owner_id,portfolio_id,type,amount_cents,balance_cents,bankroll_cents)
    values(v_user,v_id,'grant',1000000,1000000,1000000);
  return public.beter_portfolio_json(v_id);
end $$;
create function public.beter_portfolio() returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_user uuid:=auth.uid(); v_id uuid;
begin
  if v_user is null then raise exception 'authentication required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user::text,0));
  select id into v_id from public.beter_portfolios where owner_id=v_user and active;
  if v_id is null then return public.beter_create_portfolio(); end if;
  return public.beter_portfolio_json(v_id);
end $$;

create function public.beter_ingest_events(p_events jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_event jsonb; v_pick jsonb; v_count integer:=0; v_ids text[]; v_fetched timestamptz;
begin
  if jsonb_typeof(p_events)<>'array' or jsonb_array_length(p_events)>500 then raise exception 'events must be an array of at most 500 items'; end if;
  for v_event in select value from jsonb_array_elements(p_events) order by value->>'id' loop
    if coalesce(v_event->>'id','')='' or jsonb_typeof(v_event->'selections')<>'array' then raise exception 'invalid event payload'; end if;
    -- Lock before comparing timestamps, including when no event row exists yet.
    -- Sorting event IDs above gives overlapping batches the same lock order.
    perform pg_advisory_xact_lock(hashtextextended('event:'||(v_event->>'id'),0));
    v_fetched:=(v_event->>'fetched_at')::timestamptz;
    -- A slower, older poll must never roll a later feed snapshot backwards.
    if exists(select 1 from public.beter_events where id=v_event->>'id' and fetched_at>v_fetched) then continue; end if;
    insert into public.beter_events(id,sport,league,home_team,away_team,starts_at,status,provider_updated_at,fetched_at)
      values(v_event->>'id',v_event->>'sport',v_event->>'league',v_event->>'home_team',v_event->>'away_team',
        (v_event->>'starts_at')::timestamptz,case v_event->>'status' when 'live' then 'inplay' when 'final' then 'completed' else v_event->>'status' end,(v_event->>'provider_updated_at')::timestamptz,v_fetched)
      on conflict(id) do update set sport=excluded.sport,league=excluded.league,home_team=excluded.home_team,
        away_team=excluded.away_team,starts_at=excluded.starts_at,
        status=case when public.beter_events.status='completed' and excluded.status='upcoming' then 'completed' else excluded.status end,
        provider_updated_at=excluded.provider_updated_at,fetched_at=excluded.fetched_at;
    v_ids:=array[]::text[];
    for v_pick in select value from jsonb_array_elements(v_event->'selections') loop
      if coalesce(v_pick->>'id','')='' then raise exception 'invalid selection payload'; end if;
      if exists(select 1 from public.beter_selections where id=v_pick->>'id' and event_id<>v_event->>'id') then raise exception 'selection event identity changed'; end if;
      v_ids:=array_append(v_ids,v_pick->>'id');
      insert into public.beter_selections(id,event_id,team,market,line,side,odds,bookmaker,provider_updated_at,fetched_at,available)
        values(v_pick->>'id',v_event->>'id',v_pick->>'team',v_pick->>'market',(v_pick->>'line')::numeric,
          v_pick->>'side',(v_pick->>'odds')::integer,v_pick->>'bookmaker',(v_pick->>'provider_updated_at')::timestamptz,
          (v_pick->>'fetched_at')::timestamptz,true)
        on conflict(id) do update set team=excluded.team,market=excluded.market,line=excluded.line,side=excluded.side,
          odds=excluded.odds,bookmaker=excluded.bookmaker,provider_updated_at=excluded.provider_updated_at,fetched_at=excluded.fetched_at,available=true
        where public.beter_selections.fetched_at<=excluded.fetched_at and public.beter_selections.provider_updated_at<=excluded.provider_updated_at;
    end loop;
    update public.beter_selections set available=false where event_id=v_event->>'id' and not(id=any(v_ids));
    v_count:=v_count+1;
  end loop;
  return jsonb_build_object('events',v_count);
end $$;

create function public.beter_markets() returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce(jsonb_agg(to_jsonb(e)||jsonb_build_object('selections',coalesce((
    select jsonb_agg(public.beter_selection_json(s.id) order by s.market,s.side,s.id)
    from public.beter_selections s where s.event_id=e.id and s.available),'[]'::jsonb)) order by e.starts_at,e.id),'[]'::jsonb)
  from public.beter_events e where e.status='upcoming' and e.starts_at>clock_timestamp()
$$;

create function public.beter_quote(p_selection_ids jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_user uuid:=auth.uid(); v_portfolio jsonb; v_pick public.beter_selections; v_event public.beter_events; v_quote public.beter_quotes; v_decimal numeric;
begin
  if v_user is null then raise exception 'authentication required'; end if;
  if jsonb_typeof(p_selection_ids)<>'array' or jsonb_array_length(p_selection_ids)<>1 then raise exception 'choose exactly one selection for a single bet'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user::text,0));
  select * into v_pick from public.beter_selections where id=p_selection_ids->>0;
  if not found or not v_pick.available then raise exception 'selection unavailable'; end if;
  select * into v_event from public.beter_events where id=v_pick.event_id for share;
  select * into v_pick from public.beter_selections where id=p_selection_ids->>0 for share;
  if not v_pick.available then raise exception 'selection unavailable'; end if;
  if v_pick.market<>'Moneyline' then raise exception 'only moneyline markets are supported in the connected beta'; end if;
  if v_event.status<>'upcoming' or v_event.starts_at<=clock_timestamp()+interval '60 seconds' then raise exception 'market closed near game start'; end if;
  if v_pick.fetched_at<clock_timestamp()-interval '120 seconds' or v_event.fetched_at<clock_timestamp()-interval '120 seconds'
     or v_pick.provider_updated_at<clock_timestamp()-interval '180 seconds' then raise exception 'odds feed is stale'; end if;
  if v_pick.fetched_at>clock_timestamp()+interval '30 seconds' or v_pick.provider_updated_at>clock_timestamp()+interval '30 seconds'
     or v_event.fetched_at>clock_timestamp()+interval '30 seconds' or v_event.provider_updated_at>clock_timestamp()+interval '30 seconds' then raise exception 'odds timestamps are invalid'; end if;
  v_portfolio:=public.beter_portfolio();
  v_decimal:=case when v_pick.odds>0 then 1+v_pick.odds::numeric/100 else 1+100::numeric/abs(v_pick.odds) end;
  insert into public.beter_quotes(owner_id,portfolio_id,selection_id,selection,total_decimal_odds)
    values(v_user,(v_portfolio->>'id')::uuid,v_pick.id,public.beter_selection_json(v_pick.id),v_decimal) returning * into v_quote;
  return jsonb_build_object('id',v_quote.id,'expires_at',v_quote.expires_at,'selections',jsonb_build_array(v_quote.selection),'total_decimal_odds',v_decimal,'mode','single');
end $$;

create function public.beter_place_bet(p_quote_id uuid,p_stake_cents bigint,p_request_id text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_user uuid:=auth.uid(); v_portfolio public.beter_portfolios; v_quote public.beter_quotes;
  v_pick public.beter_selections; v_event public.beter_events; v_bet public.beter_bets; v_balance bigint; v_risk bigint; v_payout bigint;
  v_numerator numeric; v_denominator numeric;
begin
  if v_user is null then raise exception 'authentication required'; end if;
  if p_request_id is null or char_length(trim(p_request_id)) not between 1 and 128 then raise exception 'request ID is required'; end if;
  if p_stake_cents is null or p_stake_cents<=0 or p_stake_cents>1000000000000 then raise exception 'stake must be a positive amount in cents'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user::text,0));
  select * into v_bet from public.beter_bets where owner_id=v_user and request_id=p_request_id;
  if found then
    if v_bet.quote_id<>p_quote_id or v_bet.stake_cents<>p_stake_cents then raise exception 'request ID was already used with a different payload'; end if;
    return jsonb_build_object('bet',to_jsonb(v_bet),'portfolio',public.beter_portfolio_json(v_bet.portfolio_id));
  end if;
  perform public.beter_portfolio();
  select * into v_portfolio from public.beter_portfolios where owner_id=v_user and active for update;
  select * into v_quote from public.beter_quotes where id=p_quote_id and owner_id=v_user and portfolio_id=v_portfolio.id;
  if not found then raise exception 'quote unavailable'; end if;
  select * into v_pick from public.beter_selections where id=v_quote.selection_id;
  if not found or not v_pick.available then raise exception 'selection unavailable'; end if;
  select * into v_event from public.beter_events where id=v_pick.event_id for share;
  select * into v_pick from public.beter_selections where id=v_quote.selection_id for share;
  if not v_pick.available then raise exception 'selection unavailable'; end if;
  if v_quote.expires_at<=clock_timestamp() then raise exception 'quote expired; request fresh odds'; end if;
  if v_pick.market<>'Moneyline' then raise exception 'only moneyline markets are supported in the connected beta'; end if;
  if v_event.status<>'upcoming' or v_event.starts_at<=clock_timestamp()+interval '60 seconds' then raise exception 'market closed near game start'; end if;
  if v_pick.fetched_at<clock_timestamp()-interval '120 seconds' or v_event.fetched_at<clock_timestamp()-interval '120 seconds'
     or v_pick.provider_updated_at<clock_timestamp()-interval '180 seconds' then raise exception 'odds feed is stale'; end if;
  if v_pick.fetched_at>clock_timestamp()+interval '30 seconds' or v_pick.provider_updated_at>clock_timestamp()+interval '30 seconds'
     or v_event.fetched_at>clock_timestamp()+interval '30 seconds' or v_event.provider_updated_at>clock_timestamp()+interval '30 seconds' then raise exception 'odds timestamps are invalid'; end if;
  if (v_quote.selection->>'odds')::integer<>v_pick.odds or (v_quote.selection->'line') is distinct from to_jsonb(v_pick.line)
      and not(v_quote.selection->'line'='null'::jsonb and v_pick.line is null)
      or v_quote.selection->>'bookmaker'<>v_pick.bookmaker or v_quote.selection->>'market'<>v_pick.market or v_quote.selection->>'side'<>v_pick.side then
    raise exception 'price changed; accept a fresh quote';
  end if;
  if p_stake_cents>v_portfolio.balance_cents then raise exception 'insufficient available balance'; end if;
  -- Decimal odds may repeat (for example -120 = 11/6). Round the exact accepted
  -- American ratio once, rather than multiplying a pre-rounded decimal value.
  v_denominator:=case when (v_quote.selection->>'odds')::integer>0 then 100 else abs((v_quote.selection->>'odds')::integer) end;
  v_numerator:=case when (v_quote.selection->>'odds')::integer>0 then (v_quote.selection->>'odds')::integer+100 else abs((v_quote.selection->>'odds')::integer)+100 end;
  v_payout:=div(2::numeric*p_stake_cents*v_numerator+v_denominator,2::numeric*v_denominator)::bigint;
  if v_payout>9007199254740991 then raise exception 'potential payout is too large'; end if;
  insert into public.beter_bets(owner_id,portfolio_id,quote_id,request_id,event_id,selection_id,selections,stake_cents,potential_payout_cents,odds)
    values(v_user,v_portfolio.id,v_quote.id,p_request_id,v_event.id,v_pick.id,jsonb_build_array(v_quote.selection),p_stake_cents,v_payout,v_quote.total_decimal_odds)
    returning * into v_bet;
  update public.beter_portfolios set balance_cents=balance_cents-p_stake_cents where id=v_portfolio.id returning balance_cents into v_balance;
  select coalesce(sum(stake_cents),0) into v_risk from public.beter_bets where portfolio_id=v_portfolio.id and status='open';
  insert into public.beter_ledger(owner_id,portfolio_id,bet_id,type,amount_cents,balance_cents,bankroll_cents)
    values(v_user,v_portfolio.id,v_bet.id,'stake',-p_stake_cents,v_balance,v_balance+v_risk);
  return jsonb_build_object('bet',to_jsonb(v_bet),'portfolio',public.beter_portfolio_json(v_portfolio.id));
end $$;

create function public.beter_settlement_candidates() returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce(jsonb_agg(to_jsonb(e)||jsonb_build_object('bets',(
    select jsonb_agg(to_jsonb(b) order by b.created_at,b.id) from public.beter_bets b
    where b.event_id=e.id and (b.status='open' or b.settled_at>clock_timestamp()-interval '72 hours')
  )) order by e.starts_at,e.id),'[]'::jsonb)
  from public.beter_events e where exists(select 1 from public.beter_bets b where b.event_id=e.id and (b.status='open' or b.settled_at>clock_timestamp()-interval '72 hours'))
$$;

create function public.beter_settle(p_event_id text,p_outcomes jsonb,p_result_version text,p_evidence jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_existing public.beter_result_versions; v_latest public.beter_result_versions; v_outcome jsonb; v_bet public.beter_bets; v_status text;
  v_source_at timestamptz;
  v_payout bigint; v_delta bigint; v_balance bigint; v_risk bigint; v_count integer:=0;
begin
  if coalesce(trim(p_result_version),'')='' or char_length(p_result_version)>256 or jsonb_typeof(p_outcomes)<>'array' or jsonb_array_length(p_outcomes)=0 then raise exception 'valid result version and outcomes are required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('result:'||p_event_id,0));
  select * into v_existing from public.beter_result_versions where event_id=p_event_id and result_version=p_result_version;
  if found then
    if v_existing.outcomes<>p_outcomes or v_existing.evidence<>p_evidence then raise exception 'result version already exists with different evidence'; end if;
    return jsonb_build_object('applied',0,'duplicate',true);
  end if;
  if not exists(select 1 from public.beter_events where id=p_event_id) then raise exception 'event not found'; end if;
  for v_outcome in select value from jsonb_array_elements(p_outcomes) loop
    if coalesce(v_outcome->>'status','') not in ('won','lost','void') or (v_outcome->>'bet_id' is null and v_outcome->>'selection_id' is null) then raise exception 'invalid settlement outcome'; end if;
    if not exists(select 1 from public.beter_bets b where b.event_id=p_event_id and (
      v_outcome->>'bet_id'=b.id::text or (v_outcome->>'bet_id' is null and v_outcome->>'selection_id'=b.selection_id))) then raise exception 'settlement outcome references an unknown bet'; end if;
    if v_outcome->>'bet_id' is null and (select count(distinct (selections->0->'line')::text) from public.beter_bets where event_id=p_event_id and selection_id=v_outcome->>'selection_id')>1 then raise exception 'ambiguous accepted lines require a bet ID'; end if;
  end loop;
  if exists(select b.id from public.beter_bets b cross join jsonb_array_elements(p_outcomes) o where b.event_id=p_event_id and
    (o->>'bet_id'=b.id::text or (o->>'bet_id' is null and o->>'selection_id'=b.selection_id)) group by b.id having count(*)>1) then raise exception 'duplicate or conflicting outcomes for a bet'; end if;
  v_source_at:=coalesce(nullif(p_evidence->>'last_update',''),nullif(p_evidence->>'updated_at',''))::timestamptz;
  if v_source_at is not null and (not isfinite(v_source_at) or v_source_at>clock_timestamp()+interval '30 seconds') then raise exception 'result provider timestamp is invalid'; end if;
  select * into v_latest from public.beter_result_versions where event_id=p_event_id and applied and provider_updated_at is not null order by provider_updated_at desc,id desc limit 1;
  if found and v_source_at is not null then
    if v_source_at<v_latest.provider_updated_at then
      insert into public.beter_result_versions(event_id,result_version,outcomes,evidence,provider_updated_at,applied)
        values(p_event_id,p_result_version,p_outcomes,coalesce(p_evidence,'{}'::jsonb),v_source_at,false);
      return jsonb_build_object('applied',0,'stale',true,'duplicate',false);
    end if;
    if v_source_at=v_latest.provider_updated_at and v_latest.outcomes<>p_outcomes then raise exception 'conflicting result evidence at the same provider timestamp requires review'; end if;
  elsif found and v_source_at is null then raise exception 'result provider timestamp is required';
  end if;
  insert into public.beter_result_versions(event_id,result_version,outcomes,evidence,provider_updated_at) values(p_event_id,p_result_version,p_outcomes,coalesce(p_evidence,'{}'::jsonb),v_source_at);
  -- Order portfolio locks identically across settlement workers to reduce deadlocks.
  for v_bet in select * from public.beter_bets b where b.event_id=p_event_id and exists(
    select 1 from jsonb_array_elements(p_outcomes) o where o->>'bet_id'=b.id::text or (o->>'bet_id' is null and o->>'selection_id'=b.selection_id))
    order by b.portfolio_id,b.created_at,b.id for update loop
    select value into v_outcome from jsonb_array_elements(p_outcomes) where value->>'bet_id'=v_bet.id::text
      or(value->>'bet_id' is null and value->>'selection_id'=v_bet.selection_id) limit 1;
    v_status:=v_outcome->>'status';
    v_payout:=case v_status when 'won' then v_bet.potential_payout_cents when 'void' then v_bet.stake_cents else 0 end;
    if v_bet.status=v_status and v_bet.payout_cents=v_payout then continue; end if;
    perform 1 from public.beter_portfolios where id=v_bet.portfolio_id for update;
    v_delta:=v_payout-v_bet.payout_cents;
    update public.beter_bets set status=v_status,payout_cents=v_payout,result_version=p_result_version,settled_at=clock_timestamp() where id=v_bet.id;
    update public.beter_portfolios set balance_cents=balance_cents+v_delta where id=v_bet.portfolio_id returning balance_cents into v_balance;
    select coalesce(sum(stake_cents),0) into v_risk from public.beter_bets where portfolio_id=v_bet.portfolio_id and status='open';
    insert into public.beter_ledger(owner_id,portfolio_id,bet_id,type,amount_cents,balance_cents,bankroll_cents,result_version)
      values(v_bet.owner_id,v_bet.portfolio_id,v_bet.id,case when v_bet.status='open' then v_status else 'adjustment' end,v_delta,v_balance,v_balance+v_risk,p_result_version);
    v_count:=v_count+1;
  end loop;
  update public.beter_events set status='completed' where id=p_event_id;
  return jsonb_build_object('applied',v_count,'duplicate',false);
end $$;

create function public.beter_job_record(p_name text,p_ok boolean,p_detail jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id bigint;
begin
  if coalesce(trim(p_name),'')='' or char_length(p_name)>100 then raise exception 'job name is required'; end if;
  insert into public.beter_jobs(name,ok,detail) values(p_name,p_ok,coalesce(p_detail,'{}'::jsonb)) returning id into v_id;
  return jsonb_build_object('id',v_id);
end $$;
create function public.beter_health() returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
  select jsonb_build_object(
    'ledger_mismatches',(select count(*) from public.beter_portfolios p where p.balance_cents<>coalesce((select sum(l.amount_cents) from public.beter_ledger l where l.portfolio_id=p.id),0)),
    'open_bets',(select count(*) from public.beter_bets where status='open'),
    'unsettled_bets',(select count(*) from public.beter_bets b join public.beter_events e on e.id=b.event_id where b.status='open' and e.starts_at<clock_timestamp()-interval '6 hours'),
    'jobs',coalesce((select jsonb_agg(to_jsonb(j)) from(select distinct on(name) * from public.beter_jobs order by name,created_at desc,id desc) j),'[]'::jsonb))
$$;

alter table public.beter_portfolios enable row level security;
alter table public.beter_events enable row level security;
alter table public.beter_selections enable row level security;
alter table public.beter_quotes enable row level security;
alter table public.beter_bets enable row level security;
alter table public.beter_ledger enable row level security;
alter table public.beter_result_versions enable row level security;
alter table public.beter_jobs enable row level security;
create policy beter_own_portfolios on public.beter_portfolios for select to authenticated using(owner_id=auth.uid());
create policy beter_own_quotes on public.beter_quotes for select to authenticated using(owner_id=auth.uid());
create policy beter_own_bets on public.beter_bets for select to authenticated using(owner_id=auth.uid());
create policy beter_own_ledger on public.beter_ledger for select to authenticated using(owner_id=auth.uid());
create policy beter_public_events on public.beter_events for select to anon,authenticated using(true);
create policy beter_public_selections on public.beter_selections for select to anon,authenticated using(available);

revoke all on public.beter_portfolios,public.beter_events,public.beter_selections,public.beter_quotes,public.beter_bets,public.beter_ledger,public.beter_result_versions,public.beter_jobs from public,anon,authenticated;
grant select on public.beter_portfolios,public.beter_quotes,public.beter_bets,public.beter_ledger to authenticated;
grant select on public.beter_events,public.beter_selections to anon,authenticated;
grant all on public.beter_portfolios,public.beter_events,public.beter_selections,public.beter_quotes,public.beter_bets,public.beter_ledger,public.beter_result_versions,public.beter_jobs to service_role;
grant usage,select on sequence public.beter_result_versions_id_seq,public.beter_jobs_id_seq to service_role;

-- Supabase's default PUBLIC function execution must be removed explicitly.
revoke all on function public.beter_immutable_record(),public.beter_selection_json(text),public.beter_portfolio_json(uuid),public.beter_create_portfolio(text),public.beter_portfolio(),public.beter_ingest_events(jsonb),public.beter_markets(),public.beter_quote(jsonb),public.beter_place_bet(uuid,bigint,text),public.beter_settlement_candidates(),public.beter_settle(text,jsonb,text,jsonb),public.beter_job_record(text,boolean,jsonb),public.beter_health() from public,anon,authenticated;
grant execute on function public.beter_portfolio(),public.beter_create_portfolio(text),public.beter_quote(jsonb),public.beter_place_bet(uuid,bigint,text) to authenticated;
grant execute on function public.beter_markets() to anon,authenticated;
grant execute on function public.beter_ingest_events(jsonb),public.beter_markets(),public.beter_settlement_candidates(),public.beter_settle(text,jsonb,text,jsonb),public.beter_job_record(text,boolean,jsonb),public.beter_health() to service_role;
