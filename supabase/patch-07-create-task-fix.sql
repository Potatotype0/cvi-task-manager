-- Fix: admins, and people with no department, could not create tasks.
-- The app reads each new task straight back, and the older visibility rules look the task up
-- by id, which can't find a row created by the same statement. This rule checks the row itself.
-- Run once in the Supabase SQL Editor. Safe to run again.

drop policy if exists task_read_own on public.tasks;
create policy task_read_own on public.tasks for select to authenticated
  using (public.is_admin() or created_by = auth.uid());

-- Done. You should see "Success. No rows returned".
