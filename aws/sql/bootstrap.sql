-- AWS-only identity bootstrap. Application financial migrations remain unchanged.
-- Aurora administrators cannot grant PostgreSQL SUPERUSER/BYPASSRLS. Privileged
-- worker operations retain access through the existing SECURITY DEFINER RPCs.
do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin noinherit; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin noinherit; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin noinherit; end if;
  if not exists(select 1 from pg_roles where rolname='beter_runtime') then create role beter_runtime nologin noinherit nosuperuser nocreatedb nocreaterole noreplication; end if;
end $$;
grant anon,authenticated,service_role to beter_runtime;
revoke create on schema public from public;
grant usage on schema public to anon,authenticated,service_role,beter_runtime;
create schema if not exists auth;
revoke all on schema auth from public;
grant usage on schema auth to anon,authenticated,service_role,beter_runtime;
create table auth.users(id uuid primary key,email text not null unique);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
revoke all on function auth.uid() from public;
grant execute on function auth.uid() to anon,authenticated,service_role;
revoke all on auth.users from public,anon,authenticated,service_role,beter_runtime;

create table auth.aws_sessions(
  access_hash text primary key check(access_hash ~ '^[a-f0-9]{64}$'),
  refresh_hash text not null unique check(refresh_hash ~ '^[a-f0-9]{64}$'),
  family_hash text not null unique check(family_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid not null references auth.users(id),
  sealed_tokens text not null check(char_length(sealed_tokens) between 1 and 65536),
  access_expires_at bigint not null,
  refresh_expires_at bigint not null,
  previous_access_hash text,
  previous_refresh_hash text,
  created_at timestamptz not null default clock_timestamp()
);
create index aws_session_user on auth.aws_sessions(user_id);
create index aws_session_expiry on auth.aws_sessions(refresh_expires_at);
create table auth.aws_session_handles(
  access_hash text primary key check(access_hash ~ '^[a-f0-9]{64}$'),
  family_hash text not null check(family_hash ~ '^[a-f0-9]{64}$'),
  expires_at bigint not null
);
create index aws_session_handle_family on auth.aws_session_handles(family_hash);
create index aws_session_handle_expiry on auth.aws_session_handles(expires_at);
revoke all on auth.aws_sessions,auth.aws_session_handles from public,anon,authenticated,service_role,beter_runtime;

create function auth.beter_user_upsert(p_id uuid,p_email text) returns jsonb
language plpgsql security definer set search_path=auth,public,pg_temp as $$
begin
  if p_id is null or p_email is null or char_length(trim(p_email)) not between 3 and 254 or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'invalid verified user'; end if;
  insert into auth.users(id,email) values(p_id,lower(trim(p_email))) on conflict(id) do update set email=excluded.email;
  return jsonb_build_object('id',p_id,'email',lower(trim(p_email)));
end $$;
create function auth.beter_session_json(p_hash text) returns jsonb
language sql stable security definer set search_path=auth,public,pg_temp as $$
  select jsonb_build_object('accessHash',s.access_hash,'refreshHash',s.refresh_hash,'userId',s.user_id,'sealedTokens',s.sealed_tokens,
    'accessExpiresAt',s.access_expires_at,'refreshExpiresAt',s.refresh_expires_at,'previousAccessHash',s.previous_access_hash,
    'previousRefreshHash',s.previous_refresh_hash,'createdAt',floor(extract(epoch from s.created_at)*1000)::bigint,
    'user',jsonb_build_object('id',u.id,'email',u.email))
  from auth.aws_sessions s join auth.users u on u.id=s.user_id where s.access_hash=p_hash
$$;
create function auth.beter_session_put(p_session jsonb,p_family text default null) returns jsonb
language plpgsql security definer set search_path=auth,public,pg_temp as $$
declare v_access text:=p_session->>'accessHash'; v_refresh text:=p_session->>'refreshHash'; v_family text:=coalesce(p_family,p_session->>'accessHash');
begin
  if jsonb_typeof(p_session) is distinct from 'object' or coalesce(v_access,'') !~ '^[a-f0-9]{64}$' or coalesce(v_refresh,'') !~ '^[a-f0-9]{64}$' or
    coalesce(p_session->>'sealedTokens','')='' or char_length(p_session->>'sealedTokens')>65536 or
    (p_session->>'accessExpiresAt')::bigint<=floor(extract(epoch from clock_timestamp())*1000)::bigint or
    (p_session->>'refreshExpiresAt')::bigint<(p_session->>'accessExpiresAt')::bigint then raise exception 'invalid private session'; end if;
  insert into auth.aws_sessions(access_hash,refresh_hash,family_hash,user_id,sealed_tokens,access_expires_at,refresh_expires_at,previous_access_hash,previous_refresh_hash)
    values(v_access,v_refresh,v_family,(p_session->>'userId')::uuid,p_session->>'sealedTokens',(p_session->>'accessExpiresAt')::bigint,(p_session->>'refreshExpiresAt')::bigint,p_session->>'previousAccessHash',p_session->>'previousRefreshHash');
  insert into auth.aws_session_handles(access_hash,family_hash,expires_at) values(v_access,v_family,(p_session->>'refreshExpiresAt')::bigint);
  return auth.beter_session_json(v_access);
end $$;
create function auth.beter_session_get(p_hash text,p_kind text) returns jsonb
language plpgsql stable security definer set search_path=auth,public,pg_temp as $$
declare v_hash text;
begin
  if p_kind not in ('access','refresh') or p_hash !~ '^[a-f0-9]{64}$' then return null; end if;
  -- Access lookup intentionally includes expired access handles: the auth adapter
  -- must verify provider state and the refresh path may rotate an expired access.
  select access_hash into v_hash from auth.aws_sessions where (case p_kind when 'access' then access_hash else refresh_hash end)=p_hash
    and refresh_expires_at>floor(extract(epoch from clock_timestamp())*1000)::bigint;
  return auth.beter_session_json(v_hash);
end $$;
create function auth.beter_session_rotate(p_old_refresh text,p_session jsonb) returns boolean
language plpgsql security definer set search_path=auth,public,pg_temp as $$
declare v_old auth.aws_sessions;
begin
  select * into v_old from auth.aws_sessions where refresh_hash=p_old_refresh for update;
  if not found or v_old.refresh_expires_at<=floor(extract(epoch from clock_timestamp())*1000)::bigint then return false; end if;
  if p_session->>'userId'<>v_old.user_id::text then raise exception 'session identity cannot change during refresh'; end if;
  if p_session->>'previousAccessHash' is distinct from v_old.access_hash or p_session->>'previousRefreshHash' is distinct from v_old.refresh_hash then raise exception 'session predecessor does not match'; end if;
  delete from auth.aws_sessions where access_hash=v_old.access_hash;
  perform auth.beter_session_put(p_session,v_old.family_hash);
  return true;
end $$;
create function auth.beter_session_revoke(p_access text) returns jsonb
language plpgsql security definer set search_path=auth,public,pg_temp as $$
declare v_family text; v_access text; v_session jsonb;
begin
  select family_hash into v_family from auth.aws_session_handles where access_hash=p_access and expires_at>floor(extract(epoch from clock_timestamp())*1000)::bigint;
  if not found then return null; end if;
  select access_hash into v_access from auth.aws_sessions where family_hash=v_family for update;
  v_session:=auth.beter_session_json(v_access);
  delete from auth.aws_sessions where family_hash=v_family;
  delete from auth.aws_session_handles where family_hash=v_family;
  return v_session;
end $$;
create function auth.beter_sessions_revoke_user(p_id uuid) returns integer
language plpgsql security definer set search_path=auth,public,pg_temp as $$
declare v_count integer;
begin
  delete from auth.aws_session_handles where family_hash in(select family_hash from auth.aws_sessions where user_id=p_id);
  delete from auth.aws_sessions where user_id=p_id;get diagnostics v_count=row_count;return v_count;
end $$;
create function auth.beter_sessions_revoke_email(p_email text) returns integer
language sql security definer set search_path=auth,public,pg_temp as $$select coalesce(auth.beter_sessions_revoke_user((select id from auth.users where email=lower(trim(p_email)))),0)$$;
create function auth.beter_session_prune(p_limit integer default 1000) returns jsonb
language plpgsql security definer set search_path=auth,public,pg_temp as $$
declare v_sessions integer; v_handles integer;
begin
  if p_limit not between 1 and 10000 then raise exception 'invalid auth maintenance limit'; end if;
  delete from auth.aws_sessions where access_hash in(select access_hash from auth.aws_sessions where refresh_expires_at<=floor(extract(epoch from clock_timestamp())*1000)::bigint order by refresh_expires_at limit p_limit for update skip locked);get diagnostics v_sessions=row_count;
  delete from auth.aws_session_handles where access_hash in(select access_hash from auth.aws_session_handles where expires_at<=floor(extract(epoch from clock_timestamp())*1000)::bigint order by expires_at limit p_limit for update skip locked);get diagnostics v_handles=row_count;
  return jsonb_build_object('authSessionsDeleted',v_sessions,'authHandlesDeleted',v_handles);
end $$;
create function auth.beter_runtime_configure(p_password text) returns boolean
language plpgsql security definer set search_path=auth,public,pg_temp as $$
begin
  if p_password is null or p_password !~ '^[A-Za-z0-9_-]{32,128}$' then raise exception 'invalid runtime database credential'; end if;
  execute format('alter role beter_runtime login password %L',p_password);return true;
end $$;
revoke all on function auth.beter_user_upsert(uuid,text),auth.beter_session_json(text),auth.beter_session_put(jsonb,text),auth.beter_session_get(text,text),auth.beter_session_rotate(text,jsonb),auth.beter_session_revoke(text),auth.beter_sessions_revoke_user(uuid),auth.beter_sessions_revoke_email(text),auth.beter_session_prune(integer),auth.beter_runtime_configure(text) from public,anon,authenticated,service_role,beter_runtime;
grant execute on function auth.beter_user_upsert(uuid,text),auth.beter_session_put(jsonb,text),auth.beter_session_get(text,text),auth.beter_session_rotate(text,jsonb),auth.beter_session_revoke(text),auth.beter_sessions_revoke_user(uuid),auth.beter_sessions_revoke_email(text),auth.beter_session_prune(integer) to service_role;
