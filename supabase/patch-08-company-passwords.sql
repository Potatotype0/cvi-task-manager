-- Company-issued passwords: the admin sets them and can read them. Staff are told on the login screen.
-- Run once in the Supabase SQL Editor. Passwords set before this update can't be recovered,
-- so those accounts show "not set" until the admin gives them a new one.

create table if not exists public.account_passwords (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  password   text not null,
  updated_at timestamptz not null default now()
);
alter table public.account_passwords enable row level security;
drop policy if exists pw_admin_read on public.account_passwords;
create policy pw_admin_read on public.account_passwords for select to authenticated
  using (public.is_admin());

create or replace function public.admin_record_password(p_username text, p_password text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  insert into public.account_passwords (user_id, password)
  select id, p_password from public.profiles where username = p_username
  on conflict (user_id) do update set password = excluded.password, updated_at = now();
end $$;
grant execute on function public.admin_record_password(text, text) to authenticated;

create or replace function public.admin_set_password(p_user uuid, p_password text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if length(p_password) < 6 then raise exception 'Password must be at least 6 characters'; end if;
  update auth.users set encrypted_password = crypt(p_password, gen_salt('bf')) where id = p_user;
  insert into public.account_passwords (user_id, password) values (p_user, p_password)
  on conflict (user_id) do update set password = excluded.password, updated_at = now();
end $$;

-- Nobody is sent to the old "choose your own password" screen any more.
update public.profiles set must_change_password = false where must_change_password;

-- Done. You should see "Success. No rows returned".
