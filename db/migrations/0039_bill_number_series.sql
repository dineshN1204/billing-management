-- ---------------------------------------------------------------------------
-- 0039 - the bill number, in the challan's serial space
--
-- What this changes
-- -----------------
-- 1. A bill raised from a challan carries that challan's serial. The outward
--    KI/OUT-C/2026-27/0020 is billed as 2026-27/0020: the same job, written
--    without the challan's prefix and segment. The number is made by the
--    database and shown to the operator, not typed by them.
-- 2. A bill raised by hand - no challan behind it - takes the next free number
--    in the financial year, from a series of its own. The number is offered to
--    the operator and can be changed.
-- 3. A serial in a financial year means one job. A challan never takes a
--    serial a bill already holds, and a bill never takes a serial a challan
--    already holds, so a number can never be two unrelated things.
--
-- Why the number is made rather than typed
-- -----------------------------------------
-- A number typed by hand is a number that will be typed wrong, and a wrong
-- bill number is worse than a wrong challan number: the challan is a movement
-- record, the bill is an invoice the customer reconciles against. The rule
-- that a bill carries its challan's serial cannot be left to the operator, so
-- the database makes it and the application only shows it.
--
-- What is deliberately left alone
-- -------------------------------
-- - bills.bill_number stays free text. A historical bill typed in from paper
--   carries the number printed on that paper, and the database must keep
--   accepting it. The series form is a convention the application follows, not
--   a constraint on the column.
-- - No existing bill is renumbered. An invoice that has gone out keeps the
--   number it went out with.
-- - app_private.upsert_bill, the function that computes the money on a bill,
--   is not touched. The number is allocated by its own function, called
--   before the save, exactly as 0036 chose for the bill-to-challan link.
--
-- The shape of a number
-- ----------------------
-- A series number is exactly two segments: the financial year and the serial.
--
--     2026-27/0020        a bill, raised from challan .../0020
--     2026-27/0020-2      a bill, raised from a second outward .../0020-2
--
-- A challan number carries more segments, and the serial is its last one:
--
--     KI/IN/2026-27/0020
--     KI/OUT-C/2026-27/0020
--
-- A number that is neither - a paper invoice number such as INV-99 - belongs
-- to no series, holds no serial and is stored as it was typed.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- 1. The series
-- ---------------------------------------------------------------------------
--
-- One row per workspace and financial year. The counter only ever moves
-- forward, so a number is never handed out twice - not even for a bill that
-- was deleted, and not even for a form that was opened and abandoned. A gap
-- in the series is the price of never handing out the same number twice, and
-- it is the same price the challan numbers already pay (0016, 0035).

create table if not exists public.bill_number_sequences (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  financial_year text not null,
  next_value bigint not null default 1,
  updated_at timestamptz not null default now(),
  primary key (organization_id, financial_year),
  constraint bill_number_sequences_next_check check (next_value >= 1)
);

comment on table public.bill_number_sequences is
  'The series a bill number is taken from when a bill is raised by hand. One row per workspace and financial year. The counter only moves forward, so a number is never handed out twice.';

-- The browser has no grant on this table, exactly as on dc_number_sequences
-- (0015). Everything goes through the functions below.
revoke all on public.bill_number_sequences from public, anonymous, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Reading a number
-- ---------------------------------------------------------------------------
--
-- Three questions are asked of a number over and over: is it one of ours, what
-- is its serial, and what is its financial year. They are answered here once,
-- so that the browser and the database cannot disagree about them.

-- Whether a number is in the series form the application writes: a financial
-- year and a serial, and nothing else.
--
--   2026-27/0020        yes
--   KI/2026-27/0031     no - a prefix and a segment, which is how a bill was
--                            numbered before this migration
--   INV-99              no - a number from outside, with no series to belong to
create or replace function app_private.is_series_number(p_number text)
returns boolean
language sql
immutable
as $$
  select p_number is not null and btrim(p_number) ~ '^\d{4}-\d{2}/\d+(-\d+)?$';
$$;

revoke all on function app_private.is_series_number(text) from public, anonymous, authenticated;

-- The serial of a number: the last segment, when it is a number and the
-- segment before it is a financial year.
--
--   KI/OUT-C/2026-27/0020  -> 0020
--   2026-27/0020            -> 0020
--   2026-27/0020-2          -> 0020-2
--   INV-99                  -> null
--
-- A challan and a series bill number are read the same way, because the
-- serial is the last segment in both. The financial year is the one before
-- it, which is the third segment of a challan number and the first of a
-- series bill number.
create or replace function app_private.number_serial(p_number text)
returns text
language sql
immutable
as $$
  select case
    when p_number is null then null
    when array_length(string_to_array(btrim(p_number), '/'), 1) < 2 then null
    when split_part(btrim(p_number), '/', array_length(string_to_array(btrim(p_number), '/'), 1)) !~ '^\d+(-\d+)?$' then null
    when split_part(btrim(p_number), '/', array_length(string_to_array(btrim(p_number), '/'), 1) - 1) !~ '^\d{4}-\d{2}$' then null
    else split_part(btrim(p_number), '/', array_length(string_to_array(btrim(p_number), '/'), 1))
  end;
$$;

revoke all on function app_private.number_serial(text) from public, anonymous, authenticated;

-- The financial year of a number, or null when it has none.
create or replace function app_private.number_financial_year(p_number text)
returns text
language sql
immutable
as $$
  select case
    when p_number is null then null
    when app_private.is_series_number(p_number) then split_part(btrim(p_number), '/', 1)
    when app_private.number_serial(p_number) is not null
      then split_part(btrim(p_number), '/', array_length(string_to_array(btrim(p_number), '/'), 1) - 1)
    else null
  end;
$$;

revoke all on function app_private.number_financial_year(text) from public, anonymous, authenticated;

-- The number a serial stands for.
--
-- A serial is text, and the padding is a matter of presentation: 0020, 020
-- and 20 are the same number. The padding of a challan is configurable - the
-- DC settings screen offers it - and the bill series uses four digits, so
-- two serials have to be compared by their value rather than by their text.
-- A serial with a suffix stands for the number in front of the suffix, so
-- 0020-2 is the number 20 and the second outward made from it.
create or replace function app_private.serial_value(p_serial text)
returns numeric
language sql
immutable
as $$
  select case when p_serial ~ '^\d+' then substring(p_serial from '^\d+')::numeric else null end;
$$;

revoke all on function app_private.serial_value(text) from public, anonymous, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Whether a serial is taken
-- ---------------------------------------------------------------------------
--
-- A serial is taken when a document in this workspace already carries it in
-- this financial year. Both lists ignore deleted rows: a number that has been
-- issued is not issued again, which is what the challan numbers already do
-- (0035 skips a number a cancelled challan holds).

-- The serials the bills of a workspace hold in one financial year.
--
-- A bill in the series form holds its serial. A bill numbered the old way -
-- KI/2026-27/0031 - holds one too: the serial is the same job whatever it is
-- written next to, and a challan that later took 0031 would be a different job
-- wearing the same number.
--
-- p_exclude_bill leaves one bill out of the count. A bill being edited holds
-- the number it already holds.
create or replace function app_private.bill_serials(
  p_org uuid,
  p_financial_year text,
  p_exclude_bill uuid default null
)
returns setof text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select app_private.number_serial(b.bill_number)
  from public.bills b
  where b.organization_id = p_org
    and (p_exclude_bill is null or b.id <> p_exclude_bill)
    and app_private.number_financial_year(b.bill_number) = p_financial_year
    and app_private.number_serial(b.bill_number) is not null;
$$;

revoke all on function app_private.bill_serials(uuid, text, uuid) from public, anonymous, authenticated;

-- The serials the challans of a workspace hold in one financial year.
create or replace function app_private.dc_serials(p_org uuid, p_financial_year text)
returns setof text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select app_private.number_serial(d.dc_number)
  from public.dc_documents d
  where d.organization_id = p_org
    and app_private.number_financial_year(d.dc_number) = p_financial_year
    and app_private.number_serial(d.dc_number) is not null;
$$;

revoke all on function app_private.dc_serials(uuid, text) from public, anonymous, authenticated;

-- Whether a serial is taken, in this financial year, by a bill or by a
-- challan.
--
-- The comparison is by value, not by text, so a challan numbered with three
-- digits and a bill numbered with four are recognised as the same serial.
create or replace function app_private.bill_serial_taken(
  p_org uuid,
  p_financial_year text,
  p_serial text,
  p_exclude_bill uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from app_private.bill_serials(p_org, p_financial_year, p_exclude_bill) s
    where app_private.serial_value(s) = app_private.serial_value(p_serial)
  );
$$;

revoke all on function app_private.bill_serial_taken(uuid, text, text, uuid) from public, anonymous, authenticated;

create or replace function app_private.dc_serial_taken(p_org uuid, p_financial_year text, p_serial text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from app_private.dc_serials(p_org, p_financial_year) s
    where app_private.serial_value(s) = app_private.serial_value(p_serial)
  );
$$;

revoke all on function app_private.dc_serial_taken(uuid, text, text) from public, anonymous, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Taking a number
-- ---------------------------------------------------------------------------
--
-- The counter is moved with the same upsert that the challan numbers use
-- (0016, 0035): the row stays locked until the transaction ends, so two
-- calls at the same moment get different numbers.
--
-- The lock is on the workspace and the financial year rather than on the
-- document type, because a bill and a challan are competing for the same
-- serial space and must not be choosing at the same time.

create or replace function app_private.bill_advance_series(p_org uuid, p_financial_year text)
returns bigint
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_value bigint;
begin
  insert into public.bill_number_sequences (organization_id, financial_year, next_value)
  values (p_org, p_financial_year, 2)
  on conflict (organization_id, financial_year)
    do update set next_value = public.bill_number_sequences.next_value + 1, updated_at = now()
  returning next_value - 1 into v_value;
  return v_value;
end;
$$;

revoke all on function app_private.bill_advance_series(uuid, text) from public, anonymous, authenticated;

-- The number the form shows before anything is saved.
--
-- A read. It does not take the number, so opening the form and closing it
-- again leaves no gap, and two people looking at the same form at the same
-- time see the same number. The number that is actually used is the one the
-- reservation returns, and that is the authoritative one.
create or replace function app_private.bill_peek_number(p_org uuid, p_date date)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_fy text;
  v_value bigint;
  v_serial text;
begin
  v_fy := app_private.dc_financial_year(p_date);

  select next_value into v_value
  from public.bill_number_sequences
  where organization_id = p_org and financial_year = v_fy;

  if v_value is null then
    v_value := 1;
  end if;

  loop
    v_serial := lpad(v_value::text, 4, '0');
    exit when not app_private.dc_serial_taken(p_org, v_fy, v_serial)
      and not app_private.bill_serial_taken(p_org, v_fy, v_serial);
    v_value := v_value + 1;
  end loop;

  return format('%s/%s', v_fy, v_serial);
end;
$$;

revoke all on function app_private.bill_peek_number(uuid, date) from public, anonymous, authenticated;

-- The number a bill is saved with.
--
-- p_wanted is the number the operator has, if they have one:
--
--   null            take the next free number in the financial year
--   2026-27/0020    a series number. It is accepted when it names a challan
--                   this bill pays for - that is a bill raised from a challan,
--                   and the bill and the challan are the same job - and
--                   refused when it names somebody else's challan, or when it
--                   is a number of our own making that another bill holds.
--   INV-99          a number from outside. It is taken as it is typed and
--                   holds no serial, so there is nothing to allocate.
--
-- p_dc_ids are the challans the bill pays for, and p_exclude_bill is the
-- bill being edited, which does not count against itself.
create or replace function app_private.bill_reserve_number(
  p_org uuid,
  p_date date,
  p_wanted text default null,
  p_dc_ids uuid[] default null,
  p_exclude_bill uuid default null
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_fy text;
  v_value bigint;
  v_number text;
  v_serial text;
  v_wanted text;
  v_wanted_fy text;
  v_wanted_serial text;
  v_leading bigint;
begin
  v_fy := app_private.dc_financial_year(p_date);

  -- The lock is taken on the workspace and the financial year, and it covers
  -- both paths below. Two people saving a number of their own at the same
  -- moment must not both be told that it is free.
  perform pg_advisory_xact_lock(
    hashtextextended(p_org::text || ':billnum:' || v_fy, 0)
  );

  if p_wanted is not null and btrim(p_wanted) <> '' then
    v_wanted := btrim(p_wanted);

    -- A number from outside the series: taken as it is typed.
    if not app_private.is_series_number(v_wanted) then
      return v_wanted;
    end if;

    v_wanted_fy := app_private.number_financial_year(v_wanted);
    v_wanted_serial := app_private.number_serial(v_wanted);

    -- The financial year on the number is the bill's own, so the number and
    -- the financial year printed beside it on the invoice cannot disagree.
    if v_wanted_fy <> v_fy then
      perform app_private.raise_validation(
        'bill_number',
        format('must be in the financial year %s', v_fy)
      );
    end if;

    -- The number names a challan this bill pays for. That is a bill raised
    -- from a challan, and the bill and the challan are the same job, so the
    -- challan owns the serial and there is no separate series to take.
    --
    -- The challan is looked for by id rather than by financial year, because
    -- the number carries the bill's financial year and the challan may carry
    -- another one - a challan received in March and billed in April.
    if exists (
      select 1
      from public.dc_documents d
      where d.organization_id = p_org
        and d.id = any(coalesce(p_dc_ids, '{}'::uuid[]))
        and app_private.serial_value(app_private.number_serial(d.dc_number))
          = app_private.serial_value(v_wanted_serial)
    ) then
      return v_wanted;
    end if;

    -- The serial belongs to a challan this bill does not pay for. Refused: a
    -- number that names another job's challan would put two jobs under one
    -- number, and a search for the serial would answer with both.
    if app_private.dc_serial_taken(p_org, v_fy, v_wanted_serial) then
      perform app_private.raise_validation(
        'bill_number',
        'is the number of a challan this bill does not pay for'
      );
    end if;

    -- A number of our own making. Another bill cannot already hold it.
    if app_private.bill_serial_taken(p_org, v_fy, v_wanted_serial, p_exclude_bill) then
      perform app_private.raise_validation('bill_number', 'is already used by another bill');
    end if;

    -- Move the counter past it, so the next automatic number cannot land on
    -- the number that was just taken. A serial with a suffix - 0020-2 - has
    -- the same number behind it, and the counter moves past that.
    v_leading := app_private.serial_value(v_wanted_serial)::bigint;
    insert into public.bill_number_sequences (organization_id, financial_year, next_value)
    values (p_org, v_fy, v_leading + 1)
    on conflict (organization_id, financial_year)
      do update set next_value = greatest(public.bill_number_sequences.next_value, v_leading + 1), updated_at = now();

    return v_wanted;
  end if;

  -- No number wanted: take the next free one.
  v_value := app_private.bill_advance_series(p_org, v_fy);

  loop
    v_serial := lpad(v_value::text, 4, '0');
    exit when not app_private.dc_serial_taken(p_org, v_fy, v_serial)
      and not app_private.bill_serial_taken(p_org, v_fy, v_serial, p_exclude_bill);
    v_value := v_value + 1;
  end loop;

  update public.bill_number_sequences
  set next_value = greatest(next_value, v_value + 1), updated_at = now()
  where organization_id = p_org and financial_year = v_fy;

  v_number := format('%s/%s', v_fy, v_serial);
  return v_number;
end;
$$;

revoke all on function app_private.bill_reserve_number(uuid, date, text, uuid[], uuid) from public, anonymous, authenticated;

-- ---------------------------------------------------------------------------
-- 5. The number a challan and its bill must agree on
-- ---------------------------------------------------------------------------
--
-- A bill in the series form names a challan. When the bill is attached to a
-- challan, the two must be the same job.
--
-- A bill may cover more than one challan - a month of deliveries invoiced
-- together - and then the number carries the first challan's serial. So the
-- number has to name *a* challan the bill pays for, not necessarily this
-- one. The challan that the number names is the first one, and it is linked
-- first, so the check below finds it among the links the bill already has.
create or replace function app_private.bill_number_matches_challan(p_org uuid, p_bill uuid, p_dc uuid)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_bill_number text;
  v_bill_serial text;
  v_dc_number text;
  v_dc_serial text;
begin
  select b.bill_number into v_bill_number
  from public.bills b
  where b.organization_id = p_org and b.id = p_bill;

  -- A number from outside the series names no challan and is left alone.
  if not app_private.is_series_number(v_bill_number) then
    return;
  end if;

  v_bill_serial := app_private.number_serial(v_bill_number);

  select d.dc_number, app_private.number_serial(d.dc_number)
    into v_dc_number, v_dc_serial
  from public.dc_documents d
  where d.organization_id = p_org and d.id = p_dc;

  if v_dc_serial is not null
    and app_private.serial_value(v_bill_serial) = app_private.serial_value(v_dc_serial) then
    return;
  end if;

  -- The number may name another challan this bill already pays for.
  if exists (
    select 1
    from public.bill_dc_links l
    join public.dc_documents d
      on d.organization_id = l.organization_id and d.id = l.dc_id
    where l.organization_id = p_org
      and l.bill_id = p_bill
      and app_private.serial_value(app_private.number_serial(d.dc_number))
        = app_private.serial_value(v_bill_serial)
  ) then
    return;
  end if;

  perform app_private.raise_validation(
    'bill_number',
    format(
      'is %s, which is not the number of challan %s',
      v_bill_number, coalesce(v_dc_number, 'this challan')
    )
  );
end;
$$;

revoke all on function app_private.bill_number_matches_challan(uuid, uuid, uuid) from public, anonymous, authenticated;

-- ---------------------------------------------------------------------------
-- 6. The challan numbers, taught about bills
-- ---------------------------------------------------------------------------
--
-- A challan never takes a serial a bill holds.
--
-- The bill and the challan are the same job when the bill was raised from the
-- challan, and the challan already exists in that case, so the check the
-- sequence already makes has already passed. A serial that only a bill holds
-- is a different job - a bill raised by hand - and a challan must not take
-- it, or a search for the serial would answer with two unrelated things.
--
-- The body is the function from 0035, unchanged except for the one check
-- marked below.

create or replace function app_private.dc_reserve_number(
  p_org uuid,
  p_dc_type text,
  p_date date
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_fy text;
  v_value bigint;
  v_prefix text;
  v_segment text;
  v_padding integer;
  v_number text;
  v_serial text;
begin
  v_fy := app_private.dc_financial_year(p_date);

  perform pg_advisory_xact_lock(
    hashtextextended(p_org::text || ':dcnum:' || p_dc_type || ':' || v_fy, 0)
  );

  insert into public.dc_settings (organization_id, dc_type, prefix, segment_code, padding)
  values (p_org, p_dc_type, 'KI', app_private.dc_default_segment(p_dc_type), 4)
  on conflict (organization_id, dc_type) do nothing;

  select prefix, segment_code, padding into v_prefix, v_segment, v_padding
  from public.dc_settings
  where organization_id = p_org and dc_type = p_dc_type;

  loop
    insert into public.dc_number_sequences (organization_id, dc_type, financial_year, next_value)
    values (p_org, p_dc_type, v_fy, 2)
    on conflict (organization_id, dc_type, financial_year)
      do update set next_value = public.dc_number_sequences.next_value + 1, updated_at = now()
    returning next_value - 1 into v_value;

    v_serial := lpad(v_value::text, v_padding, '0');
    v_number := format('%s/%s/%s/%s', v_prefix, v_segment, v_fy, v_serial);

    exit when not exists (
      select 1
      from public.dc_documents d
      where d.organization_id = p_org
        and d.dc_type = p_dc_type
        and d.dc_number_normalized = lower(btrim(v_number))
    )
    -- (new) A bill may already hold this serial. See the note above.
    and not app_private.bill_serial_taken(p_org, v_fy, v_serial);
  end loop;

  return v_number;
end;
$$;

revoke all on function app_private.dc_reserve_number(uuid, text, date) from public, anonymous, authenticated;

-- The mirrored number, taught the same thing.
--
-- The body is the function from 0035, unchanged except for the one check
-- marked below.
create or replace function app_private.dc_reserve_outward_number(
  p_org uuid,
  p_inward_id uuid,
  p_date date
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_inward public.dc_documents;
  v_fy text;
  v_serial text;
  v_prefix text;
  v_segment text;
  v_padding integer;
  v_number text;
  v_try integer := 1;
begin
  select * into v_inward
  from public.dc_documents d
  where d.organization_id = p_org
    and d.id = p_inward_id
    and d.dc_type = 'inward'
    and d.deleted_at is null;

  if not found then
    perform app_private.raise_validation(
      'reference_inward_dc_id',
      'is not an inward challan in this workspace'
    );
    return null;
  end if;

  -- The part after the last slash: 0005 out of KI/IN/2026-27/0005.
  v_serial := regexp_replace(v_inward.dc_number, '^.*/', '');

  if v_serial !~ '^[0-9]+$' then
    return app_private.dc_reserve_number(p_org, 'outward_customer', p_date);
  end if;

  v_fy := app_private.dc_financial_year(p_date);

  perform pg_advisory_xact_lock(
    hashtextextended(p_org::text || ':dcnum:outward_customer:' || v_fy, 0)
  );

  insert into public.dc_settings (organization_id, dc_type, prefix, segment_code, padding)
  values (p_org, 'outward_customer', 'KI', 'OUT-C', 4)
  on conflict (organization_id, dc_type) do nothing;

  select prefix, segment_code, padding into v_prefix, v_segment, v_padding
  from public.dc_settings
  where organization_id = p_org and dc_type = 'outward_customer';

  loop
    v_number := format(
      '%s/%s/%s/%s',
      v_prefix, v_segment, v_fy,
      v_serial || case when v_try = 1 then '' else '-' || v_try::text end
    );

    exit when not exists (
      select 1
      from public.dc_documents d
      where d.organization_id = p_org
        and d.dc_type = 'outward_customer'
        and d.dc_number_normalized = lower(btrim(v_number))
    )
    -- (new) A bill may already hold this serial.
    and not app_private.bill_serial_taken(p_org, v_fy, v_serial);

    v_try := v_try + 1;
  end loop;

  return v_number;
end;
$$;

revoke all on function app_private.dc_reserve_outward_number(uuid, uuid, date) from public, anonymous, authenticated;

-- ---------------------------------------------------------------------------
-- 7. The link, checked
-- ---------------------------------------------------------------------------
--
-- The body is the function from 0029, unchanged except for the one call
-- marked below. Attaching a bill to a challan is where the two numbers meet,
-- and it is the right place to say whether they are the same job.

create or replace function public.dc_link_bills(payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_bill uuid;
  v_dc uuid;
  v_elem jsonb;
  v_prev jsonb;
  v_now jsonb;
begin
  if v_uid is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;

  v_org := app_private.parse_uuid(payload -> 'organization_id', 'organization_id', true);
  perform app_private.dc_require_movement_write(v_org);

  v_dc := app_private.parse_uuid(payload -> 'dc_id', 'dc_id', true);

  if not exists (
    select 1 from public.dc_documents d
    where d.organization_id = v_org and d.id = v_dc and d.deleted_at is null
  ) then
    perform app_private.raise_error('PT404', 'NOT_FOUND', 'delivery challan not found');
  end if;

  select coalesce(jsonb_agg(to_jsonb(l) order by l.bill_id), '[]'::jsonb)
  into v_prev
  from public.bill_dc_links l
  where l.organization_id = v_org and l.dc_id = v_dc;

  for v_elem in select value from jsonb_array_elements(coalesce(payload -> 'bills', '[]'::jsonb)) loop
    v_bill := app_private.parse_uuid(v_elem -> 'bill_id', 'bill_id', true);

    if not exists (
      select 1 from public.bills b
      where b.organization_id = v_org and b.id = v_bill and b.deleted_at is null
    ) then
      perform app_private.raise_error('PT404', 'NOT_FOUND', 'bill not found in this workspace');
    end if;

    -- (new) A bill in the series form names a challan. It has to be one
    -- this bill pays for, or the number and the challan are two jobs.
    perform app_private.bill_number_matches_challan(v_org, v_bill, v_dc);

    insert into public.bill_dc_links (organization_id, bill_id, dc_id, linked_by)
    values (v_org, v_bill, v_dc, v_uid)
    on conflict (organization_id, bill_id, dc_id) do nothing;
  end loop;

  delete from public.bill_dc_links l
  where l.organization_id = v_org
    and l.dc_id = v_dc
    and not exists (
      select 1 from jsonb_array_elements(coalesce(payload -> 'bills', '[]'::jsonb)) e
      where app_private.parse_uuid(e -> 'bill_id', 'bill_id', false) = l.bill_id
    );

  select coalesce(jsonb_agg(jsonb_build_object('bill_id', l.bill_id) order by l.bill_id), '[]'::jsonb)
  into v_now
  from public.bill_dc_links l
  where l.organization_id = v_org and l.dc_id = v_dc;

  insert into public.audit_logs (organization_id, actor_id, action, table_name, record_id, old_data, new_data, metadata)
  values (
    v_org, v_uid, 'LINK_BILLS', 'dc_documents', v_dc, v_prev, v_now,
    jsonb_build_object('source', 'dc_link_bills')
  );

  return jsonb_build_object('dc_id', v_dc, 'bills', v_now);
end;
$$;

revoke all on function public.dc_link_bills(jsonb) from public, anonymous;
grant execute on function public.dc_link_bills(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. The number, offered and taken
-- ---------------------------------------------------------------------------

-- The number the form shows before the bill is saved. A read: it does not
-- take the number, so an abandoned form leaves no gap.
create or replace function public.next_bill_number(p_org uuid, p_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;

  if not app_private.is_org_member(p_org) then
    perform app_private.raise_error('PT403', 'FORBIDDEN', 'you are not a member of this workspace');
  end if;

  if p_date is null then
    perform app_private.raise_validation('p_date', 'is required');
  end if;

  return jsonb_build_object('bill_number', app_private.bill_peek_number(p_org, p_date));
end;
$$;

revoke all on function public.next_bill_number(uuid, date) from public, anonymous;
grant execute on function public.next_bill_number(uuid, date) to authenticated;

-- The number the bill is saved with.
--
-- Called once, immediately before the save. The number it returns is the
-- authoritative one: when the form has not touched the number, the database
-- picks the next free one, which may not be the one the form showed if
-- somebody else took it in the meantime.
create or replace function public.reserve_bill_number(
  p_org uuid,
  p_date date,
  p_bill_number text default null,
  p_dc_ids uuid[] default null,
  p_bill_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_number text;
begin
  if auth.uid() is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;

  if not app_private.is_org_member(p_org) then
    perform app_private.raise_error('PT403', 'FORBIDDEN', 'you are not a member of this workspace');
  end if;

  if not app_private.can_write(p_org) then
    perform app_private.raise_error('PT403', 'FORBIDDEN', 'your role cannot modify bills');
  end if;

  if p_date is null then
    perform app_private.raise_validation('p_date', 'is required');
  end if;

  v_number := app_private.bill_reserve_number(
    p_org,
    p_date,
    nullif(btrim(coalesce(p_bill_number, '')), ''),
    coalesce(p_dc_ids, '{}'::uuid[]),
    p_bill_id
  );

  return jsonb_build_object('bill_number', v_number);
end;
$$;

revoke all on function public.reserve_bill_number(uuid, date, text, uuid[], uuid) from public, anonymous;
grant execute on function public.reserve_bill_number(uuid, date, text, uuid[], uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. Finding a bill by the number of a challan it pays for
-- ---------------------------------------------------------------------------
--
-- The same shape as bill_ids_for_customer_dc (0036), with the other side of
-- the link. A bill is named by its own number, but the number on the challan
-- it pays for is the number the operator has in their hand, and the two are
-- the same job.
create or replace function public.bill_ids_for_dc_number(p_org uuid, p_query text)
returns table (
  bill_id uuid,
  bill_number text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_term text;
begin
  if auth.uid() is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;

  if not app_private.is_org_member(p_org) then
    perform app_private.raise_error('PT403', 'FORBIDDEN', 'you are not a member of this workspace');
  end if;

  v_term := btrim(coalesce(p_query, ''));
  if v_term = '' then
    return;
  end if;

  return query
  -- Every column is named with an alias. A function whose return type is
  -- `table (bill_id uuid, bill_number text)` has OUT parameters called
  -- bill_id and bill_number, and PL/pgSQL substitutes an unqualified name that
  -- matches one of them - so an unqualified `bill_number` here would mean both
  -- the column and the parameter, and the query would be refused as ambiguous.
  select u.bill_id, u.bill_number
  from (
    select distinct b.id as bill_id, b.bill_number as bill_number
    from public.bills b
    join public.bill_dc_links l
      on l.organization_id = b.organization_id and l.bill_id = b.id
    join public.dc_documents d
      on d.organization_id = l.organization_id and d.id = l.dc_id
    where b.organization_id = p_org
      and b.deleted_at is null
      and d.dc_number ilike '%' || v_term || '%'
  ) u
  order by u.bill_number;
end;
$$;

revoke all on function public.bill_ids_for_dc_number(uuid, text) from public, anonymous;
grant execute on function public.bill_ids_for_dc_number(uuid, text) to authenticated;

commit;
