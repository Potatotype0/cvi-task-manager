-- =====================================================================
--  CVI Task Manager — database setup (run once in Supabase SQL Editor)
--  Paste the WHOLE file and press "Run".
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_cron;

-- ---------------------------------------------------------------------
--  Departments & people
-- ---------------------------------------------------------------------
create table public.departments (
  id         uuid primary key default gen_random_uuid(),
  name_ar    text not null,
  name_en    text not null,
  created_at timestamptz not null default now()
);

insert into public.departments (name_ar, name_en) values
  ('الهندسة المعمارية', 'Architecture'),
  ('الكهرباء',          'Electrical'),
  ('الميكانيك',         'Mechanical'),
  ('الإشراف الموقعي',   'Site Supervision'),
  ('الإدارة',           'Administration'),
  ('الحسابات',          'Accounts');

-- Admin pre-registers a username; only invited usernames can get an account.
create table public.invites (
  username      text primary key,
  full_name     text not null,
  role          text not null check (role in ('admin','manager','employee')),
  department_id uuid references public.departments(id),
  created_at    timestamptz not null default now()
);

create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  username      text unique not null,
  full_name     text not null,
  role          text not null check (role in ('admin','manager','employee')),
  department_id uuid references public.departments(id),
  active        boolean not null default true,
  language      text not null default 'ar' check (language in ('ar','en')),
  created_at    timestamptz not null default now()
);

-- Users log in as  <username>@cvi-tasks.local  behind the scenes.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_username text := lower(split_part(new.email, '@', 1));
  v_inv public.invites;
begin
  select * into v_inv from public.invites where username = v_username;
  if not found then
    raise exception 'Username % is not invited', v_username;
  end if;
  insert into public.profiles (id, username, full_name, role, department_id)
  values (new.id, v_username, v_inv.full_name, v_inv.role, v_inv.department_id);
  delete from public.invites where username = v_username;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- First admin. CHANGE 'admin' / the name if you want, before running.
insert into public.invites (username, full_name, role)
values ('admin', 'مدير النظام', 'admin');

-- ---------------------------------------------------------------------
--  Helper functions used by the security rules
-- ---------------------------------------------------------------------
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and active
$$;

create or replace function public.my_dept() returns uuid
language sql stable security definer set search_path = public as $$
  select department_id from public.profiles where id = auth.uid() and active
$$;

create or replace function public.is_admin() returns boolean
language sql stable as $$ select coalesce(public.my_role() = 'admin', false) $$;

-- ---------------------------------------------------------------------
--  Projects (optional link on a task)
-- ---------------------------------------------------------------------
create table public.projects (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  code          text,
  department_id uuid references public.departments(id),
  deadline      date,
  archived      boolean not null default false,
  created_by    uuid references public.profiles(id) default auth.uid(),
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------
--  Tasks
-- ---------------------------------------------------------------------
create table public.tasks (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  description   text,
  priority      text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  status        text not null default 'todo'
                check (status in ('todo','in_progress','review','returned','done')),
  due_date      date,
  department_id uuid references public.departments(id),
  project_id    uuid references public.projects(id) on delete set null,
  preset_id     uuid,                       -- filled when made from a preset
  is_shared     boolean not null default false,  -- true = one task for several people
  created_by    uuid references public.profiles(id) default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  completed_at  timestamptz
);

create table public.task_assignees (
  task_id uuid references public.tasks(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  primary key (task_id, user_id)
);

create table public.checklist_items (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references public.tasks(id) on delete cascade,
  position    int  not null default 0,
  text        text not null,
  required    boolean not null default true,
  needs_proof boolean not null default false,
  done        boolean not null default false,
  done_by     uuid references public.profiles(id),
  done_at     timestamptz,
  proof_path  text                          -- file in storage bucket 'task-files'
);

create table public.comments (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references public.tasks(id) on delete cascade,
  author_id  uuid not null references public.profiles(id) default auth.uid(),
  body       text not null,
  created_at timestamptz not null default now()
);

create table public.attachments (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references public.tasks(id) on delete cascade,
  file_path   text not null,
  file_name   text not null,
  uploaded_by uuid references public.profiles(id) default auth.uid(),
  created_at  timestamptz not null default now()
);

create or replace function public.can_manage_task(p_task uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.tasks t
    where t.id = p_task
      and ( public.is_admin()
         or t.created_by = auth.uid()
         or (public.my_role() = 'manager' and t.department_id = public.my_dept()) )
  )
$$;

create or replace function public.can_see_task(p_task uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.can_manage_task(p_task)
      or exists (select 1 from public.task_assignees a
                 where a.task_id = p_task and a.user_id = auth.uid())
$$;

-- Employees may only move status forward; nothing else on the task.
-- Nobody can send to Review until required checklist items (and proofs) are done.
create or replace function public.guard_task_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  if not public.can_manage_task(old.id) then
    if (new.title, new.description, new.priority, new.due_date, new.department_id,
        new.project_id, new.is_shared, new.created_by)
       is distinct from
       (old.title, old.description, old.priority, old.due_date, old.department_id,
        old.project_id, old.is_shared, old.created_by) then
      raise exception 'Only the task owner or a manager can edit task details';
    end if;
    if new.status is distinct from old.status
       and new.status not in ('in_progress','review') then
      raise exception 'Only a manager can approve or return a task';
    end if;
  end if;
  if new.status = 'review' and old.status <> 'review' and exists (
       select 1 from public.checklist_items c
       where c.task_id = new.id and c.required
         and (not c.done or (c.needs_proof and c.proof_path is null))) then
    raise exception 'Finish all required checklist items (with proof) first';
  end if;
  if new.status = 'done' and old.status <> 'done' then
    new.completed_at := now();
  end if;
  return new;
end $$;

create trigger tasks_guard before update on public.tasks
  for each row execute function public.guard_task_update();

-- Assignees may only tick items / attach proof, not rewrite the checklist.
create or replace function public.guard_checklist_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not public.can_manage_task(old.task_id) then
    if (new.text, new.required, new.needs_proof, new.position, new.task_id)
       is distinct from (old.text, old.required, old.needs_proof, old.position, old.task_id) then
      raise exception 'Only the task owner or a manager can change checklist items';
    end if;
    new.done_by := case when new.done then auth.uid() end;
    new.done_at := case when new.done then now() end;
  end if;
  return new;
end $$;

create trigger checklist_guard before update on public.checklist_items
  for each row execute function public.guard_checklist_update();

-- ---------------------------------------------------------------------
--  Presets (task templates) & repeating tasks
-- ---------------------------------------------------------------------
create table public.presets (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  description   text,
  priority      text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  department_id uuid references public.departments(id),   -- null = company-wide (admin only)
  due_in_days   int,
  -- [{ "text": "...", "required": true, "needs_proof": false }, ...]
  checklist     jsonb not null default '[]'::jsonb,
  -- [{ "file_path": "...", "file_name": "..." }, ...]
  attachments   jsonb not null default '[]'::jsonb,
  created_by    uuid references public.profiles(id) default auth.uid(),
  created_at    timestamptz not null default now()
);

create table public.recurrences (
  id           uuid primary key default gen_random_uuid(),
  preset_id    uuid not null references public.presets(id) on delete cascade,
  assignee_ids uuid[] not null,
  separate     boolean not null default true,     -- true = one copy per person
  frequency    text not null check (frequency in ('daily','weekly','monthly')),
  next_run     date not null,
  active       boolean not null default true,
  created_by   uuid references public.profiles(id) default auth.uid(),
  created_at   timestamptz not null default now()
);

-- Creates task(s) from a preset. Used by the app and by the daily job.
create or replace function public.create_tasks_from_preset(
  p_preset uuid, p_assignees uuid[], p_separate boolean, p_creator uuid default auth.uid())
returns setof uuid language plpgsql security definer set search_path = public as $$
declare
  v_p public.presets;
  v_user uuid;
  v_task uuid;
  v_item jsonb;
  v_pos int;
  v_att jsonb;
begin
  -- auth.uid() is null only for the daily job.
  if auth.uid() is not null and coalesce(public.my_role(), '') not in ('admin','manager') then
    raise exception 'Only managers can create tasks';
  end if;
  select * into v_p from public.presets where id = p_preset;
  if not found then raise exception 'Preset not found'; end if;

  for v_user in
    select u from unnest(case when p_separate then p_assignees else p_assignees[1:1] end) u
  loop
    insert into public.tasks (title, description, priority, due_date, department_id,
                              preset_id, is_shared, created_by)
    values (v_p.title, v_p.description, v_p.priority,
            case when v_p.due_in_days is not null then current_date + v_p.due_in_days end,
            v_p.department_id, v_p.id, not p_separate, p_creator)
    returning id into v_task;

    if p_separate then
      insert into public.task_assignees values (v_task, v_user);
    else
      insert into public.task_assignees select v_task, u from unnest(p_assignees) u;
    end if;

    v_pos := 0;
    for v_item in select * from jsonb_array_elements(v_p.checklist) loop
      insert into public.checklist_items (task_id, position, text, required, needs_proof)
      values (v_task, v_pos, v_item->>'text',
              coalesce((v_item->>'required')::boolean, true),
              coalesce((v_item->>'needs_proof')::boolean, false));
      v_pos := v_pos + 1;
    end loop;

    for v_att in select * from jsonb_array_elements(v_p.attachments) loop
      insert into public.attachments (task_id, file_path, file_name, uploaded_by)
      values (v_task, v_att->>'file_path', v_att->>'file_name', p_creator);
    end loop;

    return next v_task;
  end loop;
end $$;

create or replace function public.generate_recurring_tasks()
returns void language plpgsql security definer set search_path = public as $$
declare r public.recurrences;
begin
  for r in select * from public.recurrences where active and next_run <= current_date loop
    perform public.create_tasks_from_preset(r.preset_id, r.assignee_ids, r.separate, r.created_by);
    update public.recurrences
       set next_run = case r.frequency
                        when 'daily'   then r.next_run + 1
                        when 'weekly'  then r.next_run + 7
                        else (r.next_run + interval '1 month')::date end
     where id = r.id;
  end loop;
end $$;

-- Runs every day at 03:05 UTC.
select cron.schedule('cvi-recurring-tasks', '5 3 * * *',
                     'select public.generate_recurring_tasks()');

-- ---------------------------------------------------------------------
--  Notifications
-- ---------------------------------------------------------------------
create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  task_id    uuid references public.tasks(id) on delete cascade,
  kind       text not null,   -- assigned | review | approved | returned | comment
  read       boolean not null default false,
  created_at timestamptz not null default now()
);

create or replace function public.notify_assigned()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.notifications (user_id, task_id, kind) values (new.user_id, new.task_id, 'assigned');
  return new;
end $$;

create trigger task_assignees_notify after insert on public.task_assignees
  for each row execute function public.notify_assigned();

create or replace function public.notify_status()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = old.status then return new; end if;
  if new.status = 'review' then
    insert into public.notifications (user_id, task_id, kind)
    values (new.created_by, new.id, 'review');
  elsif new.status in ('done','returned') then
    insert into public.notifications (user_id, task_id, kind)
    select a.user_id, new.id, case new.status when 'done' then 'approved' else 'returned' end
    from public.task_assignees a where a.task_id = new.id;
  end if;
  return new;
end $$;

create trigger tasks_notify after update on public.tasks
  for each row execute function public.notify_status();

create or replace function public.notify_comment()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.notifications (user_id, task_id, kind)
  select u, new.task_id, 'comment' from (
    select a.user_id u from public.task_assignees a where a.task_id = new.task_id
    union select t.created_by from public.tasks t where t.id = new.task_id
  ) x where u is not null and u <> new.author_id;
  return new;
end $$;

create trigger comments_notify after insert on public.comments
  for each row execute function public.notify_comment();

-- ---------------------------------------------------------------------
--  Admin tools
-- ---------------------------------------------------------------------
create or replace function public.admin_set_password(p_user uuid, p_password text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if length(p_password) < 6 then raise exception 'Password must be at least 6 characters'; end if;
  update auth.users set encrypted_password = crypt(p_password, gen_salt('bf')) where id = p_user;
end $$;

-- ---------------------------------------------------------------------
--  Security rules (Row Level Security)
-- ---------------------------------------------------------------------
alter table public.departments     enable row level security;
alter table public.invites         enable row level security;
alter table public.profiles        enable row level security;
alter table public.projects        enable row level security;
alter table public.tasks           enable row level security;
alter table public.task_assignees  enable row level security;
alter table public.checklist_items enable row level security;
alter table public.comments        enable row level security;
alter table public.attachments     enable row level security;
alter table public.presets         enable row level security;
alter table public.recurrences     enable row level security;
alter table public.notifications   enable row level security;

-- Departments: everyone reads, admin writes.
create policy dep_read  on public.departments for select to authenticated using (true);
create policy dep_write on public.departments for all    to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Invites & people: admin manages; everyone can read names (needed to assign).
create policy inv_admin on public.invites for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy prof_read on public.profiles for select to authenticated using (true);
create policy prof_admin on public.profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Projects: everyone reads, managers/admin write.
create policy proj_read  on public.projects for select to authenticated using (true);
create policy proj_write on public.projects for all to authenticated
  using (public.my_role() in ('admin','manager'))
  with check (public.my_role() in ('admin','manager'));

-- Tasks: you see what you manage or what is assigned to you.
create policy task_read on public.tasks for select to authenticated
  using (public.can_see_task(id));
create policy task_insert on public.tasks for insert to authenticated
  with check (public.my_role() in ('admin','manager')
              and (public.is_admin() or department_id = public.my_dept()));
create policy task_update on public.tasks for update to authenticated
  using (public.can_see_task(id));
create policy task_delete on public.tasks for delete to authenticated
  using (public.can_manage_task(id));

create policy asg_read  on public.task_assignees for select to authenticated
  using (public.can_see_task(task_id));
create policy asg_write on public.task_assignees for all to authenticated
  using (public.can_manage_task(task_id)) with check (public.can_manage_task(task_id));

create policy chk_read   on public.checklist_items for select to authenticated
  using (public.can_see_task(task_id));
create policy chk_update on public.checklist_items for update to authenticated
  using (public.can_see_task(task_id));
create policy chk_manage on public.checklist_items for insert to authenticated
  with check (public.can_manage_task(task_id));
create policy chk_delete on public.checklist_items for delete to authenticated
  using (public.can_manage_task(task_id));

create policy com_read   on public.comments for select to authenticated
  using (public.can_see_task(task_id));
create policy com_insert on public.comments for insert to authenticated
  with check (public.can_see_task(task_id) and author_id = auth.uid());

create policy att_read   on public.attachments for select to authenticated
  using (public.can_see_task(task_id));
create policy att_insert on public.attachments for insert to authenticated
  with check (public.can_see_task(task_id));
create policy att_delete on public.attachments for delete to authenticated
  using (public.can_manage_task(task_id) or uploaded_by = auth.uid());

-- Presets: everyone reads; managers write their department's, admin writes all.
create policy pre_read  on public.presets for select to authenticated using (true);
create policy pre_write on public.presets for all to authenticated
  using (public.is_admin() or (public.my_role() = 'manager' and department_id = public.my_dept()))
  with check (public.is_admin() or (public.my_role() = 'manager' and department_id = public.my_dept()));

create policy rec_all on public.recurrences for all to authenticated
  using (public.is_admin() or created_by = auth.uid())
  with check (public.my_role() in ('admin','manager'));

create policy notif_own on public.notifications for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

grant execute on function public.create_tasks_from_preset(uuid, uuid[], boolean, uuid) to authenticated;
grant execute on function public.admin_set_password(uuid, text) to authenticated;
revoke execute on function public.generate_recurring_tasks() from public, anon, authenticated;

-- ---------------------------------------------------------------------
--  File storage (photos, proofs, attachments)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public) values ('task-files', 'task-files', false)
on conflict (id) do nothing;

create policy files_read  on storage.objects for select to authenticated
  using (bucket_id = 'task-files');
create policy files_write on storage.objects for insert to authenticated
  with check (bucket_id = 'task-files');

-- Live updates in the app.
alter publication supabase_realtime add table public.tasks, public.comments, public.notifications;

-- Done. You should see "Success. No rows returned".
