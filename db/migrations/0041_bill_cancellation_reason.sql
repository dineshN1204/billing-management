-- ---------------------------------------------------------------------------
-- 0041 - cancelling a bill records why
--
-- What this changes
-- -----------------
-- A bill could be cancelled in the database (soft_delete_bill sets deleted_at
-- and deleted_by) but nothing recorded WHY. The DC side has carried a reason
-- since 0014 (dc_documents.cancel_reason), and a cancelled invoice without a
-- reason is exactly the kind of gap an auditor asks about. The application
-- needed this before it could honestly show a cancellation dialog: a reason
-- typed into a box that goes nowhere is worse than no box.
--
-- 1. bills.cancellation_reason. Set when the bill is cancelled, cleared when
--    it is restored. Existing cancelled bills - recorded before reasons were
--    kept - get a factual note rather than a blank.
--
-- 2. app_private.soft_delete_state takes the reason as its own argument and
--    refuses to cancel a bill without one. Restores always clear it.
--
-- 3. public.soft_delete_bill grows an optional reason argument. The old call
--    shape (target_bill_id only) still works, and public.restore_bill is
--    unchanged.
--
-- Permissioning is unchanged: both public functions stay executes-for-
-- authenticated, the app_private function stays behind is_org_admin, and bill
-- writes still reach this table only through the SECURITY DEFINER RPCs - there
-- is no direct column grant for authenticated on bills.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------

alter table public.bills add column if not exists cancellation_reason text;

-- A cancelled bill that predates this column has no reason on file. The note
-- says so honestly instead of leaving an empty field for somebody later to
-- fill in with a guess.
update public.bills
set cancellation_reason = 'Cancelled by an administrator; the reason was not recorded at the time'
where deleted_at is not null
  and cancellation_reason is null;

comment on column public.bills.cancellation_reason is
  'Why this bill was cancelled. Set when the bill is cancelled, cleared when it is restored.';

-- A bill that is on the books cannot carry a cancellation reason: the pair is
-- either cancelled-with-reason or restored-without-one. The cancelling path
-- sets both fields in the same update, so the row never sits half-way.
alter table public.bills drop constraint if exists bills_cancellation_reason_check;
alter table public.bills add constraint bills_cancellation_reason_check
  check (deleted_at is not null or cancellation_reason is null);

-- ---------------------------------------------------------------------------
-- 2. The delete state, with the reason
-- ---------------------------------------------------------------------------

-- The old two-argument identity must be dropped: function identity is by
-- argument types, so creating a three-argument version would otherwise leave
-- two overloads and every old two-argument call would keep hitting the one
-- without reason handling.
drop function if exists app_private.soft_delete_state(uuid, boolean);

create function app_private.soft_delete_state(
  p_bill_id uuid,
  p_delete boolean,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_bill public.bills;
begin
  if v_uid is null then
    perform app_private.raise_error('PT401', 'UNAUTHENTICATED', 'authentication required');
  end if;
  select b.organization_id into v_org from public.bills b where b.id = p_bill_id;
  if v_org is null or not app_private.is_org_member(v_org) then
    perform app_private.raise_error('PT404', 'NOT_FOUND', 'bill not found', jsonb_build_object('bill_id', p_bill_id));
  end if;
  if not app_private.is_org_admin(v_org) then
    perform app_private.raise_error('PT403', 'FORBIDDEN', 'only organization admins can delete or restore bills');
  end if;

  p_reason := case when p_reason is null then null else nullif(btrim(p_reason), '') end;
  if char_length(p_reason) > 2000 then
    perform app_private.raise_validation('reason', 'is limited to 2000 characters');
  end if;
  if p_delete and p_reason is null then
    perform app_private.raise_validation('reason', 'is required: say why this bill is being cancelled');
  end if;

  select * into v_bill from public.bills b where b.id = p_bill_id for update;
  if p_delete then
    if v_bill.deleted_at is null then
      update public.bills b
      set deleted_at = now(),
          deleted_by = v_uid,
          cancellation_reason = p_reason,
          updated_by = v_uid,
          version = b.version + 1
      where b.id = p_bill_id;
    end if;
  else
    if v_bill.deleted_at is not null then
      update public.bills b
      set deleted_at = null,
          deleted_by = null,
          cancellation_reason = null,
          updated_by = v_uid,
          version = b.version + 1
      where b.id = p_bill_id;
    end if;
  end if;
  return app_private.bill_json(p_bill_id);
end;
$$;

revoke all on function app_private.soft_delete_state(uuid, boolean, text)
  from public, anonymous, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The public wrappers
-- ---------------------------------------------------------------------------

drop function if exists public.soft_delete_bill(uuid);
drop function if exists public.restore_bill(uuid);

create function public.soft_delete_bill(target_bill_id uuid, reason text default null)
returns jsonb
language sql
volatile
security definer
set search_path = pg_catalog, public
as $$
  select app_private.soft_delete_state(target_bill_id, true, reason);
$$;

create function public.restore_bill(target_bill_id uuid)
returns jsonb
language sql
volatile
security definer
set search_path = pg_catalog, public
as $$
  select app_private.soft_delete_state(target_bill_id, false);
$$;

revoke all on function public.soft_delete_bill(uuid, text) from public, anonymous;
revoke all on function public.restore_bill(uuid) from public, anonymous;

grant execute on function public.soft_delete_bill(uuid, text) to authenticated;
grant execute on function public.restore_bill(uuid) to authenticated;

commit;
