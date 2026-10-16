-- Stall Day — Supabase schema (Postgres 15+)
-- Run in the Supabase SQL editor or as the first migration.
--
-- Auth model
--   admin    : Supabase Auth email/password; set auth.users.raw_app_meta_data = {"app_role":"admin","fair_id":"<uuid>"}
--   owner    : custom JWT minted by the `pin-login` Edge Function, claims {sub, role:"authenticated", app_role:"owner",  fair_id, stall_id}
--   helper   : same Edge Function, claims {..., app_role:"helper", helper_id}
--   customer : supabase.auth.signInAnonymously(); then upsert a `customers` row with id = auth.uid()
--   board    : reads through the security-definer view `board_tokens` (no phone numbers), granted to anon
--
-- Money is whole rupees (int). Times are timestamptz.

create extension if not exists pgcrypto;

-- ───────────────────────── enums ─────────────────────────
create type stall_kind    as enum ('food', 'goods');
create type order_status  as enum ('verify', 'hold', 'pending', 'ready', 'done', 'cancelled');
create type pay_method    as enum ('GPay', 'PhonePe', 'Paytm', 'UPI', 'Cash', 'Pay at stall');
create type order_mode    as enum ('upi', 'hold', 'cash');
create type notice_kind   as enum ('Lost', 'Found', 'Notice');
create type settle_method as enum ('UPI', 'cash');

-- ───────────────────────── claim helpers ─────────────────────────
create or replace function app_role() returns text language sql stable as $$
  select coalesce(auth.jwt() ->> 'app_role', auth.jwt() -> 'app_metadata' ->> 'app_role', 'customer')
$$;
create or replace function app_fair() returns uuid language sql stable as $$
  select nullif(coalesce(auth.jwt() ->> 'fair_id', auth.jwt() -> 'app_metadata' ->> 'fair_id'), '')::uuid
$$;
create or replace function app_stall() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'stall_id', '')::uuid
$$;
create or replace function is_admin_of(f uuid) returns boolean language sql stable as $$
  select app_role() = 'admin' and app_fair() = f
$$;
create or replace function is_staff_of(s uuid) returns boolean language sql stable as $$
  select app_role() in ('owner', 'helper') and app_stall() = s
$$;

-- ───────────────────────── tables ─────────────────────────
create table fairs (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  slug          text unique not null,                 -- used in URLs / QR: /<slug>/s/<stall_id>
  school_upi    text not null,
  invite_code   text not null,
  payment_check text not null default 'owner' check (payment_check in ('owner', 'customer')),
  created_at    timestamptz not null default now()
);

create table causes (
  id      uuid primary key default gen_random_uuid(),
  fair_id uuid not null references fairs on delete cascade,
  name    text not null,
  unique (fair_id, name)
);

create table stalls (
  id          uuid primary key default gen_random_uuid(),
  fair_id     uuid not null references fairs on delete cascade,
  prefix      text not null check (prefix ~ '^[A-Z]{1,2}$'),
  name        text not null,
  category    text not null default 'Food',
  kind        stall_kind not null default 'food',
  hours       text,
  owner_name  text not null,
  owner_role  text,
  phone       text not null,                          -- WhatsApp number, digits only, 10
  pin_hash    text not null,                          -- crypt(pin, gen_salt('bf'))
  pin_must_change boolean not null default false,
  failed_logins   int not null default 0,
  locked_until    timestamptz,
  upi_id      text,
  about       text,
  photo_path  text,                                   -- storage: photos/<fair>/<stall>/...
  cause_id    uuid references causes on delete set null,
  cut_pct     int not null default 10 check (cut_pct between 0 and 100),
  paused      boolean not null default false,
  pause_msg   text default 'Back in 10 min',
  next_token  int not null default 1,
  closeout    jsonb,                                  -- {upi_actual, cash_actual, note, closed_at}
  created_at  timestamptz not null default now(),
  unique (fair_id, prefix),
  unique (fair_id, phone)
);

create table helpers (
  id         uuid primary key default gen_random_uuid(),
  stall_id   uuid not null references stalls on delete cascade,
  name       text not null,
  phone      text not null,
  pin_hash   text not null,
  created_at timestamptz not null default now(),
  unique (stall_id, phone)
);

create table items (
  id         uuid primary key default gen_random_uuid(),
  stall_id   uuid not null references stalls on delete cascade,
  name       text not null,
  note       text,
  price      int not null check (price >= 0),
  stock      int not null default 0 check (stock >= 0),
  available  boolean not null default true,
  sizes      text[],
  tags       text[] not null default '{}' check (tags <@ array['veg','vegan','jain','egg','nuts','dairy','gluten','spicy']),
  photo_path text,
  sort       int not null default 0,
  created_at timestamptz not null default now()
);

create table combos (
  id       uuid primary key default gen_random_uuid(),
  stall_id uuid not null references stalls on delete cascade,
  name     text not null,
  item_ids uuid[] not null check (cardinality(item_ids) >= 2),
  price    int not null check (price > 0)
);

create table customers (
  id         uuid primary key,                        -- = auth.uid() of anonymous session
  fair_id    uuid not null references fairs on delete cascade,
  name       text not null,
  phone      text not null,
  created_at timestamptz not null default now()
);

create table orders (
  id             uuid primary key default gen_random_uuid(),
  stall_id       uuid not null references stalls on delete cascade,
  token          text not null,
  customer_id    uuid references customers on delete set null,
  customer_name  text not null,
  customer_phone text,
  status         order_status not null,
  paid_by        pay_method not null,
  total          int not null check (total >= 0),      -- includes donation
  donation       int not null default 0 check (donation >= 0),
  school_share   int not null default 0,               -- frozen at placement: round((total-donation)*cut/100)+donation
  hold_until     timestamptz,
  taken_by       uuid references helpers on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (stall_id, token)
);
create index on orders (stall_id, status, created_at);
create index on orders (customer_id);

create table order_lines (
  id       uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders on delete cascade,
  item_id  uuid references items on delete set null,
  combo_id uuid references combos on delete set null,
  name     text not null,
  size     text,
  qty      int not null check (qty > 0),
  price    int not null check (price >= 0)
);
create index on order_lines (order_id);

create table settlements (
  id         uuid primary key default gen_random_uuid(),
  stall_id   uuid not null references stalls on delete cascade,
  amount     int not null check (amount > 0),
  method     settle_method not null,
  created_at timestamptz not null default now()
);

create table donations (
  id         uuid primary key default gen_random_uuid(),
  fair_id    uuid not null references fairs on delete cascade,
  customer_id uuid references customers on delete set null,
  name       text,
  amount     int not null check (amount > 0),
  created_at timestamptz not null default now()
);

create table notices (
  id         uuid primary key default gen_random_uuid(),
  fair_id    uuid not null references fairs on delete cascade,
  kind       notice_kind not null,
  text       text not null check (length(text) <= 200),
  by_name    text,
  by_phone   text,                                    -- only admin can read
  open       boolean not null default true,
  created_at timestamptz not null default now()
);

create table templates (
  fair_id uuid not null references fairs on delete cascade,
  key     text not null check (key in ('invite', 'receipt', 'ready', 'reminder', 'thankyou')),
  body    text not null,
  primary key (fair_id, key)
);

create table invites (
  id         uuid primary key default gen_random_uuid(),
  fair_id    uuid not null references fairs on delete cascade,
  name       text,
  phone      text not null,
  created_at timestamptz not null default now()
);

create table push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  subject    text not null,                           -- 'stall:<id>' | 'customer:<id>'
  endpoint   text not null unique,
  keys       jsonb not null,
  created_at timestamptz not null default now()
);

-- keep updated_at fresh
create or replace function touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
create trigger orders_touch before update on orders for each row execute function touch();

-- ───────────────────────── order functions ─────────────────────────
-- p_lines: [{"item_id": "...", "size": "M", "qty": 2}] or [{"combo_id": "...", "qty": 1}]
create or replace function place_order(
  p_stall uuid, p_lines jsonb, p_mode order_mode, p_paid_by pay_method default 'UPI', p_donation int default 0
) returns orders
language plpgsql security definer set search_path = public as $$
declare
  s        stalls;
  f        fairs;
  c        customers;
  o        orders;
  l        jsonb;
  it       items;
  cb       combos;
  part     uuid;
  subtotal int := 0;
  v_status order_status;
  v_name   text;
  v_phone  text;
begin
  select * into s from stalls where id = p_stall for update;            -- serialises tokens + stock per stall
  if not found then raise exception 'stall not found'; end if;
  select * into f from fairs where id = s.fair_id;

  if p_mode = 'cash' then
    if not is_staff_of(p_stall) then raise exception 'not allowed'; end if;
    v_name := 'Walk-up'; v_status := 'done'; p_paid_by := 'Cash'; p_donation := 0;
  else
    if s.paused then raise exception 'stall is paused'; end if;
    select * into c from customers where id = auth.uid();
    if not found then raise exception 'customer profile missing'; end if;
    v_name := c.name; v_phone := c.phone;
    if p_mode = 'hold' then
      if s.kind <> 'goods' then raise exception 'holds only for goods stalls'; end if;
      v_status := 'hold'; p_paid_by := 'Pay at stall';
    else
      v_status := case when f.payment_check = 'owner' then 'verify' else 'pending' end;
    end if;
  end if;

  if jsonb_array_length(p_lines) = 0 then raise exception 'empty order'; end if;

  insert into orders (stall_id, token, customer_id, customer_name, customer_phone, status, paid_by, total, donation,
                      hold_until, taken_by)
  values (p_stall, s.prefix || '-' || lpad(s.next_token::text, 2, '0'), c.id, v_name, v_phone, v_status, p_paid_by, 0,
          greatest(p_donation, 0),
          case when p_mode = 'hold' then now() + interval '15 minutes' end,
          case when app_role() = 'helper' then nullif(auth.jwt() ->> 'helper_id', '')::uuid end)
  returning * into o;
  update stalls set next_token = next_token + 1 where id = p_stall;

  for l in select * from jsonb_array_elements(p_lines) loop
    if (l->>'qty')::int <= 0 then raise exception 'bad qty'; end if;
    if l ? 'combo_id' then
      select * into cb from combos where id = (l->>'combo_id')::uuid and stall_id = p_stall;
      if not found then raise exception 'combo not found'; end if;
      foreach part in array cb.item_ids loop
        update items set stock = stock - (l->>'qty')::int
          where id = part and stall_id = p_stall and available and stock >= (l->>'qty')::int;
        if not found then raise exception 'out of stock'; end if;
      end loop;
      insert into order_lines (order_id, combo_id, name, qty, price) values (o.id, cb.id, cb.name, (l->>'qty')::int, cb.price);
      subtotal := subtotal + cb.price * (l->>'qty')::int;
    else
      update items set stock = stock - (l->>'qty')::int
        where id = (l->>'item_id')::uuid and stall_id = p_stall and available and stock >= (l->>'qty')::int
        returning * into it;
      if not found then raise exception 'out of stock'; end if;
      insert into order_lines (order_id, item_id, name, size, qty, price) values (o.id, it.id, it.name, l->>'size', (l->>'qty')::int, it.price);
      subtotal := subtotal + it.price * (l->>'qty')::int;
    end if;
  end loop;

  update orders set total = subtotal + o.donation,
                    school_share = round(subtotal * s.cut_pct / 100.0)::int + o.donation
   where id = o.id returning * into o;
  return o;
end $$;

-- Allowed transitions:
--   verify → pending (payment received)        hold → done (paid cash) | cancelled (release)
--   pending → ready → done                      any non-done → cancelled (owner)
create or replace function set_order_status(p_order uuid, p_status order_status) returns orders
language plpgsql security definer set search_path = public as $$
declare o orders; ln order_lines; cb combos; part uuid;
begin
  select * into o from orders where id = p_order for update;
  if not found or not is_staff_of(o.stall_id) then raise exception 'not allowed'; end if;
  if not (
       (o.status = 'verify'  and p_status in ('pending', 'cancelled'))
    or (o.status = 'hold'    and p_status in ('done', 'cancelled'))
    or (o.status = 'pending' and p_status in ('ready', 'cancelled'))
    or (o.status = 'ready'   and p_status in ('done'))
  ) then raise exception 'bad transition % → %', o.status, p_status; end if;

  if p_status = 'cancelled' then                              -- put stock back
    for ln in select * from order_lines where order_id = o.id loop
      if ln.combo_id is not null then
        select * into cb from combos where id = ln.combo_id;
        foreach part in array cb.item_ids loop update items set stock = stock + ln.qty where id = part; end loop;
      elsif ln.item_id is not null then
        update items set stock = stock + ln.qty where id = ln.item_id;
      end if;
    end loop;
  end if;

  update orders set status = p_status,
                    paid_by = case when o.status = 'hold' and p_status = 'done' then 'Cash' else paid_by end
   where id = o.id returning * into o;
  return o;
end $$;

-- release expired holds (schedule every minute with pg_cron, or call from the client on load)
create or replace function release_expired_holds() returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  for r in select id, stall_id from orders where status = 'hold' and hold_until < now() loop
    perform set_config('request.jwt.claims', json_build_object('app_role','owner','stall_id',r.stall_id)::text, true);
    perform set_order_status(r.id, 'cancelled'); n := n + 1;
  end loop;
  return n;
end $$;

-- ───────────────────────── reporting views ─────────────────────────
create or replace view stall_totals with (security_invoker = true) as
select s.id as stall_id, s.fair_id, s.name, s.cut_pct,
       count(o.*) filter (where o.status in ('pending','ready','done'))                            as orders,
       coalesce(sum(o.total) filter (where o.status in ('pending','ready','done')), 0)             as total,
       coalesce(sum(o.total) filter (where o.status in ('pending','ready','done') and o.paid_by = 'Cash'), 0) as cash,
       coalesce(sum(o.total) filter (where o.status in ('pending','ready','done') and o.paid_by <> 'Cash'), 0) as upi,
       coalesce(sum(o.school_share) filter (where o.status in ('pending','ready','done')), 0)      as school_owed,
       coalesce((select sum(amount) from settlements st where st.stall_id = s.id), 0)              as school_received,
       count(o.*) filter (where o.status in ('verify','hold','pending'))                           as waiting
from stalls s left join orders o on o.stall_id = s.id
group by s.id;

-- token board: no personal data, readable by anon
create or replace view board_tokens as
select o.stall_id, s.fair_id, s.name as stall_name, o.token, o.status, o.created_at
from orders o join stalls s on s.id = o.stall_id
where o.status in ('verify', 'pending', 'ready') and o.created_at > now() - interval '18 hours';
grant select on board_tokens to anon, authenticated;

-- ───────────────────────── row level security ─────────────────────────
alter table fairs              enable row level security;
alter table causes             enable row level security;
alter table stalls             enable row level security;
alter table helpers            enable row level security;
alter table items              enable row level security;
alter table combos             enable row level security;
alter table customers          enable row level security;
alter table orders             enable row level security;
alter table order_lines        enable row level security;
alter table settlements        enable row level security;
alter table donations          enable row level security;
alter table notices            enable row level security;
alter table templates          enable row level security;
alter table invites            enable row level security;
alter table push_subscriptions enable row level security;

-- public catalogue (anyone with the link)
create policy fair_read    on fairs   for select using (true);
create policy cause_read   on causes  for select using (true);
create policy item_read    on items   for select using (true);
create policy combo_read   on combos  for select using (true);
create policy notice_read  on notices for select using (open or is_admin_of(fair_id));
create policy tmpl_read    on templates for select using (true);

-- stalls: public columns via view; owners edit own; admin edits all in fair
create or replace view stalls_public as
select id, fair_id, prefix, name, category, kind, hours, owner_name, owner_role, upi_id, about, photo_path,
       cause_id, cut_pct, paused, pause_msg
from stalls;
grant select on stalls_public to anon, authenticated;
create policy stall_staff_read  on stalls for select using (is_staff_of(id) or is_admin_of(fair_id));
create policy stall_owner_write on stalls for update using (app_role() = 'owner' and app_stall() = id);
create policy stall_admin_write on stalls for all    using (is_admin_of(fair_id)) with check (is_admin_of(fair_id));
-- owners may not change cut_pct / pin / fair: enforce with a trigger
create or replace function guard_stall_update() returns trigger language plpgsql as $$
begin
  if app_role() <> 'admin' and (new.cut_pct <> old.cut_pct or new.fair_id <> old.fair_id or new.prefix <> old.prefix
                                or new.pin_hash <> old.pin_hash or new.next_token <> old.next_token) then
    raise exception 'only admin can change that';
  end if;
  return new;
end $$;
create trigger stalls_guard before update on stalls for each row execute function guard_stall_update();

create policy item_owner_write  on items  for all using (app_role() = 'owner' and app_stall() = stall_id) with check (app_role() = 'owner' and app_stall() = stall_id);
create policy combo_owner_write on combos for all using (app_role() = 'owner' and app_stall() = stall_id) with check (app_role() = 'owner' and app_stall() = stall_id);
create policy helper_owner      on helpers for all using (app_role() = 'owner' and app_stall() = stall_id) with check (app_role() = 'owner' and app_stall() = stall_id);

-- customers
create policy cust_self on customers for all using (id = auth.uid()) with check (id = auth.uid());

-- orders: customer sees own; staff sees stall; admin sees fair. Writes only via functions.
create policy order_read on orders for select using (
  customer_id = auth.uid()
  or is_staff_of(stall_id)
  or exists (select 1 from stalls s where s.id = stall_id and is_admin_of(s.fair_id))
);
create policy line_read on order_lines for select using (
  exists (select 1 from orders o where o.id = order_id)        -- inherits orders RLS
);

create policy settle_read  on settlements for select using (
  (app_role() = 'owner' and app_stall() = stall_id)
  or exists (select 1 from stalls s where s.id = stall_id and is_admin_of(s.fair_id)));
create policy settle_admin on settlements for insert with check (
  exists (select 1 from stalls s where s.id = stall_id and is_admin_of(s.fair_id)));

create policy don_insert on donations for insert with check (customer_id = auth.uid());
create policy don_admin  on donations for select using (is_admin_of(fair_id));

create policy notice_insert on notices for insert with check (auth.uid() is not null and kind in ('Lost', 'Found') or is_admin_of(fair_id));
create policy notice_admin  on notices for update using (is_admin_of(fair_id));

create policy tmpl_admin   on templates for all using (is_admin_of(fair_id)) with check (is_admin_of(fair_id));
create policy cause_admin  on causes    for all using (is_admin_of(fair_id)) with check (is_admin_of(fair_id));
create policy fair_admin   on fairs     for update using (is_admin_of(id));
create policy invite_admin on invites   for all using (is_admin_of(fair_id)) with check (is_admin_of(fair_id));
-- push_subscriptions: written by the `push-subscribe` Edge Function with the service role; no client policies.

-- hide phone numbers on notices from non-admins: clients read via this view
create or replace view notices_public as select id, fair_id, kind, text, by_name, open, created_at from notices where open;
grant select on notices_public to anon, authenticated;

-- function grants
revoke all on function place_order, set_order_status, release_expired_holds from public;
grant execute on function place_order(uuid, jsonb, order_mode, pay_method, int) to authenticated;
grant execute on function set_order_status(uuid, order_status)                 to authenticated;

-- ───────────────────────── realtime ─────────────────────────
alter publication supabase_realtime add table orders, notices, settlements, items, stalls;

-- ───────────────────────── privacy: purge 30 days after ─────────────────────────
-- schedule daily with pg_cron:  select cron.schedule('purge-pii', '0 3 * * *', 'select purge_pii()');
create or replace function purge_pii() returns void language sql security definer set search_path = public as $$
  update orders    set customer_phone = null where created_at < now() - interval '30 days' and customer_phone is not null;
  update notices   set by_phone = null       where created_at < now() - interval '30 days';
  delete from customers                       where created_at < now() - interval '30 days';
$$;

-- keep-alive for the free tier (call from a GitHub Action / Cloudflare cron every 3 days)
create or replace function ping() returns text language sql stable as $$ select 'ok' $$;
grant execute on function ping() to anon;

-- ───────────────────────── seed (matches the prototype) ─────────────────────────
do $$
declare f uuid; c_lib uuid; c_sport uuid; c_garden uuid; s1 uuid; s2 uuid; s3 uuid;
        a1 uuid; a4 uuid;
begin
  insert into fairs (name, slug, school_upi, invite_code) values ('Greenfield School Fair', 'greenfield', 'pta.greenfield@oksbi', 'FAIR24') returning id into f;
  insert into causes (fair_id, name) values (f, 'Library books') returning id into c_lib;
  insert into causes (fair_id, name) values (f, 'Sports day kit') returning id into c_sport;
  insert into causes (fair_id, name) values (f, 'School garden') returning id into c_garden;
  insert into causes (fair_id, name) values (f, 'School fund');

  insert into stalls (fair_id, prefix, name, category, kind, hours, owner_name, owner_role, phone, pin_hash, upi_id, about, cause_id, cut_pct)
  values (f, 'A', 'Sunny Snacks', 'Food', 'food', '10 am – 1 pm', 'Priya Rao', 'Parent · Class 4B', '9845011111', crypt('1111', gen_salt('bf')),
          'priya.rao@okaxis', 'I bake on weekends and wanted the kids to have a healthier snack corner.', c_lib, 10) returning id into s1;
  insert into stalls (fair_id, prefix, name, category, kind, hours, owner_name, owner_role, phone, pin_hash, upi_id, about, cause_id, cut_pct)
  values (f, 'B', 'Thread & Thimble', 'Clothes', 'goods', 'All day', 'Anita Menon', 'Parent · Class 7A', '9845022222', crypt('2222', gen_salt('bf')),
          'anita.m@ybl', 'Hand-block printed kurtas and kids tees from a small Jaipur workshop.', c_sport, 15) returning id into s2;
  insert into stalls (fair_id, prefix, name, category, kind, hours, owner_name, owner_role, phone, pin_hash, upi_id, about, cause_id, cut_pct)
  values (f, 'C', 'Little Makers', 'Crafts', 'goods', '11 am – 2 pm', 'Grade 6 Eco Club', 'Run by students · Ms. Fernandes', '9845033333', crypt('3333', gen_salt('bf')),
          'ecoclub.school@okicici', 'Everything here was made by Grade 6 students from recycled materials.', c_garden, 100) returning id into s3;

  insert into helpers (stall_id, name, phone, pin_hash) values (s1, 'Ishaan', '9845044444', crypt('4444', gen_salt('bf')));

  insert into items (stall_id, name, note, price, stock, tags, sort) values (s1, 'Veg grilled sandwich', 'Paneer, corn, mint chutney', 40, 24, '{veg,dairy,gluten}', 1) returning id into a1;
  insert into items (stall_id, name, note, price, stock, tags, sort) values
    (s1, 'Masala Maggi', 'Extra veggies', 50, 15, '{veg,gluten,spicy}', 2),
    (s1, 'Samosa (2 pcs)', 'With tamarind chutney', 30, 4, '{vegan,gluten}', 3);
  insert into items (stall_id, name, note, price, stock, tags, sort) values (s1, 'Fresh lime soda', 'Sweet or salted', 20, 30, '{vegan,jain}', 4) returning id into a4;
  insert into items (stall_id, name, note, price, stock, tags, sort) values
    (s1, 'Chocolate brownie', 'Home-baked', 30, 12, '{egg,nuts,dairy,gluten}', 5),
    (s1, 'Cold coffee', 'Ask for less sugar', 45, 0, '{veg,dairy}', 6);
  insert into combos (stall_id, name, item_ids, price) values (s1, 'Snack combo', array[a1, a4], 55);

  insert into items (stall_id, name, note, price, stock, sizes, sort) values
    (s2, 'Hand-block kurta', 'Indigo or rust', 650, 9, '{S,M,L,XL}', 1),
    (s2, 'Kids printed tee', 'Soft cotton', 299, 18, '{4–6,6–8,8–10,10–12}', 2),
    (s2, 'Cotton tote bag', 'Fits a laptop', 180, 3, null, 3),
    (s2, 'Scrunchie set of 3', 'Mixed prints', 120, 14, null, 4);
  insert into items (stall_id, name, note, price, stock, sort) values
    (s3, 'Painted clay diya', 'Set of 2', 50, 20, 1),
    (s3, 'Bookmark set', 'Pressed flowers', 40, 25, 2),
    (s3, 'Seed paper card', 'Plant it after reading', 60, 7, 3);

  insert into templates (fair_id, key, body) values
    (f, 'invite',   E'Hi {name}! 👋 You''re invited to run a stall at the school fair.\n1. Open {link}\n2. Tap "Stall login" → "Join with invite code"\n3. Enter code {code}\nThen add your menu, photos and UPI ID. See you there!'),
    (f, 'receipt',  E'Stall Day receipt 🧾\n{stall} · Token {token}\n{items}\nTotal ₹{total} ({paidBy})\n₹{schoolShare} goes to {cause}. Thank you!'),
    (f, 'ready',    'Hi {name}! Your order {token} at {stall} is ready — please collect it. 😊'),
    (f, 'reminder', 'Hi {owner}, thank you for running {stall}! The school''s share is ₹{due}. Please pay to {schoolUpi} when you can. 🙏'),
    (f, 'thankyou', 'Thank you {owner}! {stall} raised ₹{raised} for {cause} today across {orders} orders. You made the fair special. — Greenfield PTA');
end $$;

-- ───────────────────────── Edge Functions to write (outline) ─────────────────────────
-- pin-login      POST {phone, pin} → checks stalls / helpers with crypt(); 5 fails → locked_until = now()+10min;
--                signs JWT with SUPABASE_JWT_SECRET: {sub: stall_id|helper_id, role:'authenticated', app_role, fair_id, stall_id, helper_id, exp: +12h}
-- join-stall     POST {code, stall, owner, phone, pin} → validates invite_code, inserts stall (next free prefix), returns JWT
-- reset-pin      admin only → pin_hash = crypt('0000'), pin_must_change = true
-- push-subscribe POST {subject, subscription} → upsert push_subscriptions (service role)
-- push-notify    DB webhook on orders INSERT (→ 'stall:<id>') and UPDATE status→ready (→ 'customer:<id>'); sends Web Push (VAPID)
-- nightly-backup cron 21:00 IST → CSV of orders + stall_totals to storage bucket `backups/`, email signed URL to admin
