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
