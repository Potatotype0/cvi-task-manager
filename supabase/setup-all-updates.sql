-- All updates in one file. Run once in the Supabase SQL Editor. Safe to run again.

-- ===== patch-02-stage-1.sql =====
-- Stage 1 update: approval choice, employees' own tasks, trash, history, file limit.
-- Run once in the Supabase SQL Editor. Safe to run even if patch-01 was skipped.

-- ---------------------------------------------------------------------
--  From patch-01: department board and drawing link
-- ---------------------------------------------------------------------
create or replace function public.task_in_my_dept(p_task uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.tasks t
                 where t.id = p_task and t.department_id = public.my_dept())
$$;

alter table public.tasks add column if not exists drawing_link text;

drop policy if exists task_read_dept on public.tasks;
create policy task_read_dept on public.tasks for select to authenticated
  using (department_id = public.my_dept());
drop policy if exists asg_read_dept on public.task_assignees;
create policy asg_read_dept on public.task_assignees for select to authenticated
  using (public.task_in_my_dept(task_id));

-- ---------------------------------------------------------------------
--  Approval choice and trash
-- ---------------------------------------------------------------------
alter table public.tasks add column if not exists needs_approval boolean not null default true;
alter table public.tasks add column if not exists deleted_at timestamptz;

create or replace function public.guard_task_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  if not public.can_manage_task(old.id) then
    if (new.title, new.description, new.priority, new.due_date, new.department_id,
        new.project_id, new.is_shared, new.created_by, new.needs_approval,
        new.drawing_link, new.deleted_at)
       is distinct from
       (old.title, old.description, old.priority, old.due_date, old.department_id,
        old.project_id, old.is_shared, old.created_by, old.needs_approval,
        old.drawing_link, old.deleted_at) then
      raise exception 'Only the task owner or a manager can edit task details';
    end if;
    if new.status is distinct from old.status
       and (old.status = 'done'
            or not (new.status in ('in_progress','review')
                    or (new.status = 'done' and not old.needs_approval))) then
      raise exception 'Only a manager can approve or return a task';
    end if;
  elsif public.my_role() = 'employee' and new.department_id is distinct from old.department_id then
    raise exception 'Only a manager can change the department';
  end if;
  if new.status in ('review','done') and old.status not in ('review', new.status) and exists (
       select 1 from public.checklist_items c
       where c.task_id = new.id and c.required
         and (not c.done or (c.needs_proof and c.proof_path is null))) then
    raise exception 'Finish all required checklist items (with proof) first';
  end if;
  if new.status = 'done' and old.status <> 'done' then
    new.completed_at := now();
  elsif new.status <> 'done' then
    new.completed_at := null;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------
--  Employees can create tasks for themselves only
-- ---------------------------------------------------------------------
drop policy if exists task_insert on public.tasks;
create policy task_insert on public.tasks for insert to authenticated
  with check (
    public.is_admin()
    or (public.my_role() = 'manager' and department_id is not distinct from public.my_dept())
    or (public.my_role() = 'employee' and created_by = auth.uid() and not needs_approval
        and department_id is not distinct from public.my_dept())
  );

create or replace function public.guard_assignee()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.my_role() = 'employee' and new.user_id <> auth.uid() then
    raise exception 'Employees can only assign tasks to themselves';
  end if;
  return new;
end $$;

drop trigger if exists task_assignees_guard on public.task_assignees;
create trigger task_assignees_guard before insert on public.task_assignees
  for each row execute function public.guard_assignee();

-- ---------------------------------------------------------------------
--  History: who changed what, and when
-- ---------------------------------------------------------------------
create table if not exists public.task_history (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references public.tasks(id) on delete cascade,
  actor_id   uuid references public.profiles(id),
  action     text not null,
  detail     text,
  created_at timestamptz not null default now()
);
create index if not exists task_history_task on public.task_history (task_id, created_at);

alter table public.task_history enable row level security;
drop policy if exists hist_read on public.task_history;
create policy hist_read on public.task_history for select to authenticated
  using (public.can_see_task(task_id));

create or replace function public.log_task_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.task_history (task_id, actor_id, action) values (new.id, auth.uid(), 'created');
    return new;
  end if;
  if new.status is distinct from old.status then
    insert into public.task_history (task_id, actor_id, action, detail) values (new.id, auth.uid(), 'status', new.status);
  end if;
  if new.due_date is distinct from old.due_date then
    insert into public.task_history (task_id, actor_id, action, detail) values (new.id, auth.uid(), 'due', new.due_date::text);
  end if;
  if new.priority is distinct from old.priority then
    insert into public.task_history (task_id, actor_id, action, detail) values (new.id, auth.uid(), 'priority', new.priority);
  end if;
  if new.title is distinct from old.title then
    insert into public.task_history (task_id, actor_id, action, detail) values (new.id, auth.uid(), 'title', new.title);
  end if;
  if new.deleted_at is distinct from old.deleted_at then
    insert into public.task_history (task_id, actor_id, action)
    values (new.id, auth.uid(), case when new.deleted_at is null then 'restored' else 'deleted' end);
  end if;
  return new;
end $$;

drop trigger if exists tasks_history on public.tasks;
create trigger tasks_history after insert or update on public.tasks
  for each row execute function public.log_task_change();

-- The exists check skips rows removed because the whole task was permanently deleted.
create or replace function public.log_assignee_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.task_history (task_id, actor_id, action, detail)
    values (new.task_id, auth.uid(), 'assigned', new.user_id::text);
    return new;
  end if;
  if exists (select 1 from public.tasks where id = old.task_id) then
    insert into public.task_history (task_id, actor_id, action, detail)
    values (old.task_id, auth.uid(), 'unassigned', old.user_id::text);
  end if;
  return old;
end $$;

drop trigger if exists task_assignees_history on public.task_assignees;
create trigger task_assignees_history after insert or delete on public.task_assignees
  for each row execute function public.log_assignee_change();

-- ---------------------------------------------------------------------
--  Empty the trash after 30 days (every day at 02:30 UTC)
-- ---------------------------------------------------------------------
select cron.schedule('cvi-empty-trash', '30 2 * * *',
                     $$delete from public.tasks where deleted_at < now() - interval '30 days'$$);

-- ---------------------------------------------------------------------
--  File limit and storage use
-- ---------------------------------------------------------------------
update storage.buckets set file_size_limit = 10485760 where id = 'task-files';

create or replace function public.storage_used_bytes() returns bigint
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  return (select coalesce(sum((metadata->>'size')::bigint), 0)
          from storage.objects where bucket_id = 'task-files');
end $$;
grant execute on function public.storage_used_bytes() to authenticated;

-- Done. You should see one row with a job number, or "Success".

-- ===== patch-03-stage-2.sql =====
-- Stage 2 update: phone notifications and automatic reminders.
-- Run once in the Supabase SQL Editor, after patch-02.

create extension if not exists pg_net;

alter table public.notifications add column if not exists detail text;
alter table public.notifications add column if not exists pushed_at timestamptz;

-- ---------------------------------------------------------------------
--  Which devices receive notifications
-- ---------------------------------------------------------------------
create table if not exists public.push_subscriptions (
  endpoint   text primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  p256dh     text not null,
  auth       text not null,
  language   text not null default 'ar',
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
drop policy if exists push_own on public.push_subscriptions;
create policy push_own on public.push_subscriptions for select to authenticated
  using (user_id = auth.uid());

-- A shared device moves to whoever logged in last, so these go through functions.
create or replace function public.save_push_subscription(
  p_endpoint text, p_p256dh text, p_auth text, p_language text)
returns void language sql security definer set search_path = public as $$
  insert into public.push_subscriptions (endpoint, user_id, p256dh, auth, language)
  values (p_endpoint, auth.uid(), p_p256dh, p_auth, p_language)
  on conflict (endpoint) do update
    set user_id = auth.uid(), p256dh = excluded.p256dh, auth = excluded.auth, language = excluded.language
$$;

create or replace function public.delete_push_subscription(p_endpoint text)
returns void language sql security definer set search_path = public as $$
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid()
$$;

grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;
grant execute on function public.delete_push_subscription(text) to authenticated;

-- ---------------------------------------------------------------------
--  Hand each new notification to the sender function.
--  Daily due and overdue items stay in the app: the morning summary carries them,
--  so nobody gets a burst of alerts at 8:00.
-- ---------------------------------------------------------------------
create or replace function public.send_push_for_notification()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.kind in ('due_soon', 'overdue') then return new; end if;
  begin
    perform net.http_post(
      url := 'https://edbscawkzoyavgaoicye.supabase.co/functions/v1/send-push',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := jsonb_build_object('notification_id', new.id)
    );
  exception when others then
    null;  -- A failed alert must never block the task change that caused it.
  end;
  return new;
end $$;

drop trigger if exists notifications_push on public.notifications;
create trigger notifications_push after insert on public.notifications
  for each row execute function public.send_push_for_notification();

-- ---------------------------------------------------------------------
--  Nobody is alerted about their own actions
-- ---------------------------------------------------------------------
create or replace function public.notify_assigned()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.user_id is distinct from auth.uid() then
    insert into public.notifications (user_id, task_id, kind) values (new.user_id, new.task_id, 'assigned');
  end if;
  return new;
end $$;

create or replace function public.notify_status()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = old.status then return new; end if;
  if new.status = 'review' and new.created_by is distinct from auth.uid() then
    insert into public.notifications (user_id, task_id, kind) values (new.created_by, new.id, 'review');
  elsif new.status = 'done' and not new.needs_approval then
    if new.created_by is distinct from auth.uid() then
      insert into public.notifications (user_id, task_id, kind) values (new.created_by, new.id, 'completed');
    end if;
  elsif new.status in ('done','returned') then
    insert into public.notifications (user_id, task_id, kind)
    select a.user_id, new.id, case new.status when 'done' then 'approved' else 'returned' end
    from public.task_assignees a
    where a.task_id = new.id and a.user_id is distinct from auth.uid();
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------
--  Daily reminders: 8:00 Baghdad, not on Fridays
-- ---------------------------------------------------------------------
create or replace function public.run_daily_reminders()
returns void language plpgsql security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Baghdad')::date;
  v_soon  date;
begin
  if extract(dow from v_today) = 5 then return; end if;
  -- On Thursday "tomorrow" also covers Saturday, the next working day.
  v_soon := case when extract(dow from v_today) = 4 then v_today + 2 else v_today + 1 end;

  -- These are daily snapshots, so yesterday's copies are replaced.
  delete from public.notifications where kind in ('due_soon', 'overdue', 'morning');

  insert into public.notifications (user_id, task_id, kind)
  select a.user_id, t.id, case when t.due_date < v_today then 'overdue' else 'due_soon' end
  from public.tasks t
  join public.task_assignees a on a.task_id = t.id
  join public.profiles p on p.id = a.user_id and p.active
  where t.deleted_at is null and t.status in ('todo','in_progress','returned')
    and (t.due_date < v_today or t.due_date between v_today + 1 and v_soon);

  -- Each late task is reported to the manager once. Departments with no manager go to the admin.
  insert into public.notifications (user_id, task_id, kind)
  select m.id, t.id, 'overdue_manager'
  from public.tasks t
  join public.profiles m on m.active and (
    (m.role = 'manager' and m.department_id = t.department_id)
    or (m.role = 'admin' and not exists (
      select 1 from public.profiles x
      where x.active and x.role = 'manager' and x.department_id = t.department_id)))
  where t.deleted_at is null and t.status in ('todo','in_progress','returned')
    and t.due_date < v_today
    and not exists (select 1 from public.notifications n where n.kind = 'overdue_manager' and n.task_id = t.id);

  insert into public.notifications (user_id, kind, detail)
  select user_id, 'morning', concat_ws('|', due_today, due_soon, late)
  from (
    select a.user_id,
      count(*) filter (where t.due_date = v_today) as due_today,
      count(*) filter (where t.due_date > v_today and t.due_date <= v_soon) as due_soon,
      count(*) filter (where t.due_date < v_today) as late
    from public.tasks t
    join public.task_assignees a on a.task_id = t.id
    join public.profiles p on p.id = a.user_id and p.active
    where t.deleted_at is null and t.status in ('todo','in_progress','returned') and t.due_date is not null
    group by a.user_id
  ) counts
  where due_today + due_soon + late > 0;
end $$;

-- ---------------------------------------------------------------------
--  Weekly summary to managers: Thursday 13:00 Baghdad
-- ---------------------------------------------------------------------
create or replace function public.run_weekly_summary()
returns void language plpgsql security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Baghdad')::date;
begin
  delete from public.notifications where kind = 'weekly';
  insert into public.notifications (user_id, kind, detail)
  select id, 'weekly', concat_ws('|', finished, late, in_review)
  from (
    select m.id,
      count(*) filter (where t.status = 'done' and t.completed_at > now() - interval '7 days') as finished,
      count(*) filter (where t.status in ('todo','in_progress','returned') and t.due_date < v_today) as late,
      count(*) filter (where t.status = 'review') as in_review
    from public.profiles m
    left join public.tasks t on t.deleted_at is null and (m.role = 'admin' or t.department_id = m.department_id)
    where m.active and m.role in ('admin','manager')
    group by m.id
  ) counts
  where finished + late + in_review > 0;
end $$;

-- ---------------------------------------------------------------------
--  Daily repeating tasks skip Fridays
-- ---------------------------------------------------------------------
create or replace function public.generate_recurring_tasks()
returns void language plpgsql security definer set search_path = public as $$
declare
  r public.recurrences;
  v_today date := (now() at time zone 'Asia/Baghdad')::date;
begin
  for r in select * from public.recurrences where active and next_run <= v_today loop
    if r.frequency = 'daily' and extract(dow from v_today) = 5 then
      update public.recurrences set next_run = v_today + 1 where id = r.id;
      continue;
    end if;
    perform public.create_tasks_from_preset(r.preset_id, r.assignee_ids, r.separate, r.created_by);
    update public.recurrences
       set next_run = case r.frequency
                        when 'daily'   then r.next_run + 1
                        when 'weekly'  then r.next_run + 7
                        else (r.next_run + interval '1 month')::date end
     where id = r.id;
  end loop;
end $$;

revoke execute on function public.run_daily_reminders() from public, anon, authenticated;
revoke execute on function public.run_weekly_summary() from public, anon, authenticated;
revoke execute on function public.send_push_for_notification() from public, anon, authenticated;

-- Times are UTC: 05:00 is 8:00 in Baghdad, 10:00 is 13:00. Day 5 is Friday, day 4 is Thursday.
select cron.schedule('cvi-daily-reminders', '0 5 * * 0-4,6', 'select public.run_daily_reminders()');
select cron.schedule('cvi-weekly-summary', '0 10 * * 4', 'select public.run_weekly_summary()');

-- Done. You should see one row with a job number.

-- ===== patch-04-stage-3.sql =====
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

-- ===== patch-05-stage-4.sql =====
-- Stage 4 update: phone numbers for the WhatsApp button.
-- Run once in the Supabase SQL Editor. Only the admin can edit numbers; logged-in staff can read them.

alter table public.profiles add column if not exists phone text;

-- Done. You should see "Success. No rows returned".

-- ===== patch-06-launch.sql =====
-- Launch update: everyone sets their own password at first login.
-- Run once in the Supabase SQL Editor. Existing accounts are not affected.

alter table public.profiles add column if not exists must_change_password boolean not null default false;

-- People can only clear their own flag, and only the admin can set it.
create or replace function public.password_changed()
returns void language sql security definer set search_path = public as $$
  update public.profiles set must_change_password = false where id = auth.uid()
$$;
grant execute on function public.password_changed() to authenticated;

-- A password the admin resets is temporary too, so the person must replace it.
create or replace function public.admin_set_password(p_user uuid, p_password text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if length(p_password) < 6 then raise exception 'Password must be at least 6 characters'; end if;
  update auth.users set encrypted_password = crypt(p_password, gen_salt('bf')) where id = p_user;
  update public.profiles set must_change_password = (p_user <> auth.uid()) where id = p_user;
end $$;

-- Done. You should see "Success. No rows returned".
