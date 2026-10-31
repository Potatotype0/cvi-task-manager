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
