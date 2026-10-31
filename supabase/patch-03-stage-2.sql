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
