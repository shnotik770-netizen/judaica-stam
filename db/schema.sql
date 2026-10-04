-- סכמת judaica-stam. כל הפקודות בטוחות להרצה חוזרת (idempotent).
create extension if not exists pgcrypto;

-- לקוחות — customer_number הוא המזהה היציב שספק הסת"ם (יודאיקה פלוס) מקשר אליו, לעולם לא ממוחזר.
create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  customer_number text not null unique,
  first_name text not null,
  last_name text not null,
  phone text not null,
  address text not null,
  created_at timestamptz not null default now()
);

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  customer_id uuid not null references customers(id),
  status text not null default 'open',
  notes text,
  target_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- שקיות — יחידת המעקב מול הספק. כל שקית = ברקוד נפרד, יכולה לנוע בנפרד מהזמנה שלה.
create table if not exists bags (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  bag_code text not null unique,
  item_type text not null check (item_type in
    ('tefillin_pair','tefillin_head','tefillin_hand','mezuzah','megillah','sefer_torah','nach','other')),
  item_type_note text,
  quantity int not null default 1,
  status text not null default 'waiting_pickup' check (status in ('waiting_pickup','with_supplier','returned')),
  result jsonb,
  picked_up_at timestamptz,
  returned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_bags_order on bags(order_id);
create index if not exists idx_bags_status on bags(status);

-- מפתחות API לספקים חיצוניים (כרגע: יודאיקה פלוס). נשמר רק hash, לא הערך עצמו.
create table if not exists api_keys (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  key_hash text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
