revoke update on public.ocr_jobs from authenticated;
grant update (deleted_at) on public.ocr_jobs to authenticated;
drop policy ocr_jobs_insert on public.ocr_jobs;
create policy ocr_jobs_insert on public.ocr_jobs
  for insert to authenticated
  with check (
    app_private.can_write(organization_id)
    and created_by = (select auth.uid())
    and status = 'queued'
    and staging = '{}'::jsonb
    and engine is null
    and confidence is null
  );
