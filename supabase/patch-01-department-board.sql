-- Lets employees see (read only) their own department's tasks on the board.
-- Run once in the Supabase SQL Editor, after schema.sql.

create or replace function public.task_in_my_dept(p_task uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.tasks t
                 where t.id = p_task and t.department_id = public.my_dept())
$$;

-- Optional link to a drawing on a task.
alter table public.tasks add column if not exists drawing_link text;

create policy task_read_dept on public.tasks for select to authenticated
  using (department_id = public.my_dept());
create policy asg_read_dept on public.task_assignees for select to authenticated
  using (public.task_in_my_dept(task_id));
