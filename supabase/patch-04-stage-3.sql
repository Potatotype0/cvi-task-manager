-- Stage 3 update: monthly backup reminder for the admin.
-- Run once in the Supabase SQL Editor, after patch-03.

create or replace function public.run_backup_reminder()
returns void language sql security definer set search_path = public as $$
  insert into public.notifications (user_id, kind)
  select id, 'backup' from public.profiles where active and role = 'admin'
$$;

revoke execute on function public.run_backup_reminder() from public, anon, authenticated;

-- The 1st of every month at 05:00 UTC, which is 8:00 in Baghdad.
select cron.schedule('cvi-backup-reminder', '0 5 1 * *', 'select public.run_backup_reminder()');

-- Done. You should see one row with a job number.
