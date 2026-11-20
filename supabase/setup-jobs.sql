-- Apply after deploying the Edge Function. Store both secrets with Supabase Vault:
-- beter_worker_url: https://<project-ref>.supabase.co/functions/v1/beter/api/jobs/process
-- beter_job_secret: the same private value as the function's JOB_SECRET.
-- No credentials belong in this file or Git history.
create extension if not exists pg_cron;
create extension if not exists pg_net;
do $$ begin
  if not exists(select 1 from vault.decrypted_secrets where name='beter_worker_url') or
     not exists(select 1 from vault.decrypted_secrets where name='beter_job_secret') then
    raise exception 'Configure beter_worker_url and beter_job_secret in Vault before scheduling jobs';
  end if;
  if not exists(select 1 from cron.job where jobname='beter-market-and-result-sync') then
    perform cron.schedule('beter-market-and-result-sync','* * * * *',$job$
      select net.http_post(
        url:=(select decrypted_secret from vault.decrypted_secrets where name='beter_worker_url' limit 1),
        headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='beter_job_secret' limit 1)),
        body:='{}'::jsonb,timeout_milliseconds:=50000
      );
    $job$);
  end if;
end $$;
