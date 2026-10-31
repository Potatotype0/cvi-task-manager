-- Stage 4 update: phone numbers for the WhatsApp button.
-- Run once in the Supabase SQL Editor. Only the admin can edit numbers; logged-in staff can read them.

alter table public.profiles add column if not exists phone text;

-- Done. You should see "Success. No rows returned".
