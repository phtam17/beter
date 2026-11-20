/** Local development backend. Hosted deployments use Supabase Auth and Postgres. */
import { PGlite } from '@electric-sql/pglite';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ApiFault, type Backend } from './api.ts';

type User = { id: string; email: string };
type SessionResult = { session: { access_token: string; refresh_token: string; user: User; expires_at: number }; user: User };
type Options = { dataDir?: string; now?: () => Date; migrationPath?: string; migrationDir?: string };
type Queryable = Pick<PGlite, 'query'>;
const derive = promisify(scrypt) as (password: string, salt: string, length: number) => Promise<Buffer>;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const ACCESS_TTL = 3_600_000;
const REFRESH_TTL = 30 * 86_400_000;
const authFailure = () => new ApiFault(401, 'AUTH_FAILED', 'Sign in failed. Check your email and password.');
function validToken(token: unknown): token is string { return typeof token === 'string' && /^[a-f0-9]{64}$/.test(token); }
function credentials(body: Record<string, unknown>): { email: string; password: string } {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiFault(400, 'INVALID_EMAIL', 'Enter a valid email address.');
  if (typeof body.password !== 'string' || body.password.length < 10 || body.password.length > 200) throw new ApiFault(400, 'INVALID_PASSWORD', 'Use a password with 10 to 200 characters.');
  return { email, password: body.password };
}

export async function createLocalBackend({ dataDir, now = () => new Date(), migrationPath, migrationDir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url)) }: Options = {}): Promise<Backend & { close(): Promise<void> }> {
  if (dataDir) await mkdir(dataDir, { recursive: true });
  const db = dataDir ? new PGlite(dataDir) : new PGlite();
  try {
    await db.exec(`
      do $$ begin
        if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
        if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
        if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role bypassrls; end if;
      end $$;
      create schema if not exists auth;
      create table if not exists auth.users(id uuid primary key,email text not null unique);
      create or replace function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
      $$;
      grant usage on schema auth to anon,authenticated,service_role;
      grant execute on function auth.uid() to anon,authenticated,service_role;
      create table if not exists auth.local_credentials(
        user_id uuid primary key references auth.users(id) on delete cascade,
        salt text not null,password_hash text not null
      );
      create table if not exists auth.local_sessions(
        access_hash text primary key,refresh_hash text not null unique,
        user_id uuid not null references auth.users(id) on delete cascade,
        expires_at bigint not null,refresh_expires_at bigint not null
      );
      create index if not exists local_sessions_user on auth.local_sessions(user_id);
      create table if not exists auth.local_migrations(id text primary key,checksum text not null);
      revoke all on auth.local_credentials,auth.local_sessions,auth.local_migrations from public,anon,authenticated,service_role;
    `);
    const paths = migrationPath ? [migrationPath] : (await readdir(migrationDir)).filter(name => /^\d+.*\.sql$/.test(name)).sort().map(name => join(migrationDir, name));
    if (!paths.length) throw new Error('No database migrations were found.');
    for (const path of paths) {
      const migration = await readFile(path, 'utf8');
      const migrationId = basename(path), checksum = digest(migration);
      const applied = await db.query<{ checksum: string }>('select checksum from auth.local_migrations where id=$1', [migrationId]);
      if (applied.rows.length && applied.rows[0].checksum !== checksum) throw new Error('The local database migration changed after it was applied. Use a separate local data directory or an explicit follow-up migration.');
      if (!applied.rows.length) await db.transaction(async tx => {
        if (migration.trim()) await tx.exec(migration);
        await tx.query('insert into auth.local_migrations(id,checksum) values($1,$2)', [migrationId, checksum]);
      });
    }
  } catch (error) { await db.close(); throw error; }

  async function issueSession(query: Queryable, user: User): Promise<SessionResult> {
    const accessToken = randomBytes(32).toString('hex'), refreshToken = randomBytes(32).toString('hex');
    const current = now().getTime();
    await query.query('insert into auth.local_sessions(access_hash,refresh_hash,user_id,expires_at,refresh_expires_at) values($1,$2,$3,$4,$5)', [digest(accessToken), digest(refreshToken), user.id, current + ACCESS_TTL, current + REFRESH_TTL]);
    return { session: { access_token: accessToken, refresh_token: refreshToken, user, expires_at: Math.floor((current + ACCESS_TTL) / 1000) }, user };
  }
  async function authenticate(token: string): Promise<User> {
    if (!validToken(token)) throw authFailure();
    const result = await db.query<User>('select u.id,u.email from auth.local_sessions s join auth.users u on u.id=s.user_id where s.access_hash=$1 and s.expires_at>$2', [digest(token), now().getTime()]);
    if (!result.rows.length) throw authFailure();
    return result.rows[0];
  }
  let closed = false;
  return {
    authenticate,
    async auth(action, body, token = '') {
      if (action === 'recover') throw new ApiFault(501, 'EMAIL_UNCONFIGURED', 'Email recovery requires configured Supabase. Local development does not send account emails.');
      if (action === 'signout') {
        await authenticate(token);
        await db.query('delete from auth.local_sessions where access_hash=$1', [digest(token)]);
        return { ok: true };
      }
      if (action === 'refresh') {
        if (!validToken(body.refresh_token)) throw authFailure();
        const refreshHash = digest(body.refresh_token);
        return db.transaction(async tx => {
          const found = await tx.query<User>('select u.id,u.email from auth.local_sessions s join auth.users u on u.id=s.user_id where s.refresh_hash=$1 and s.refresh_expires_at>$2 for update of s', [refreshHash, now().getTime()]);
          if (!found.rows.length) throw authFailure();
          const next = await issueSession(tx, found.rows[0]);
          await tx.query('delete from auth.local_sessions where refresh_hash=$1', [refreshHash]);
          return next;
        });
      }
      if (action !== 'signup' && action !== 'signin') throw new ApiFault(400, 'INVALID_AUTH_ACTION', 'Choose a valid account action.');
      const { email, password } = credentials(body);
      if (action === 'signup') {
        const salt = randomBytes(32).toString('hex'), passwordHash = (await derive(password, salt, 64)).toString('hex');
        try {
          return await db.transaction(async tx => {
            const user = { id: randomUUID(), email };
            await tx.query('insert into auth.users(id,email) values($1,$2)', [user.id, user.email]);
            await tx.query('insert into auth.local_credentials(user_id,salt,password_hash) values($1,$2,$3)', [user.id, salt, passwordHash]);
            return issueSession(tx, user);
          });
        } catch (error) {
          if ((error as { code?: string }).code === '23505') throw new ApiFault(409, 'ACCOUNT_EXISTS', 'An account already uses this email. Sign in instead.');
          throw error;
        }
      }
      const result = await db.query<User & { salt: string; password_hash: string }>('select u.id,u.email,c.salt,c.password_hash from auth.users u join auth.local_credentials c on c.user_id=u.id where u.email=$1', [email]);
      const stored = result.rows[0];
      // Missing accounts perform the same password work and expose the same response.
      const candidate = await derive(password, stored?.salt ?? '0'.repeat(64), 64);
      const expected = stored ? Buffer.from(stored.password_hash, 'hex') : Buffer.alloc(64);
      if (!timingSafeEqual(candidate, expected) || !stored) throw authFailure();
      return issueSession(db, { id: stored.id, email: stored.email });
    },
    async rpc(name, args = {}, token = '') {
      if (!/^beter_[a-z_]+$/.test(name) || !args || typeof args !== 'object' || Array.isArray(args)) throw new ApiFault(400, 'INVALID_RPC', 'Invalid database operation.');
      const keys = Object.keys(args);
      if (keys.some(key => !/^p_[a-z_]+$/.test(key))) throw new ApiFault(400, 'INVALID_RPC', 'Invalid database arguments.');
      const role = token === '$service' ? 'service_role' : token ? 'authenticated' : 'anon';
      const user = token && token !== '$service' ? await authenticate(token) : null;
      const values = keys.map(key => args[key] !== null && typeof args[key] === 'object' ? JSON.stringify(args[key]) : args[key]);
      return db.transaction(async tx => {
        await tx.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role',$2,true),set_config('request.jwt.claims',$3,true)", [user?.id ?? '', role, JSON.stringify({ sub: user?.id ?? '', role })]);
        await tx.exec(`set local role ${role}`);
        const result = await tx.query<{ result: unknown }>(`select public.${name}(${keys.map((key, index) => `${key} => $${index + 1}`).join(',')}) as result`, values);
        return result.rows[0].result;
      });
    },
    async close() { if (!closed) { closed = true; await db.close(); } },
  };
}
