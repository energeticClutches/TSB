-- Menu photos in Supabase Storage (public read; Owner/Manager upload).
-- Skipped where the storage schema doesn't exist (local PGlite tests).
-- Upgrade path: move images to Cloudflare R2 when bandwidth grows (docs/IMPLEMENTATION-NOTES.md).
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'storage schema not present; skipping bucket setup';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('menu', 'menu', true, 1048576, array['image/webp', 'image/jpeg', 'image/png'])
  on conflict (id) do update set public = true, file_size_limit = 1048576,
    allowed_mime_types = array['image/webp', 'image/jpeg', 'image/png'];

  execute $p$
    create policy menu_images_write on storage.objects for insert to authenticated
    with check (bucket_id = 'menu' and (select app.current_role()) in ('owner', 'manager')
                and (storage.foldername(name))[1] = (select app.current_branch_id())::text)
  $p$;
  execute $p$
    create policy menu_images_update on storage.objects for update to authenticated
    using (bucket_id = 'menu' and (select app.current_role()) in ('owner', 'manager')
           and (storage.foldername(name))[1] = (select app.current_branch_id())::text)
  $p$;
  execute $p$
    create policy menu_images_delete on storage.objects for delete to authenticated
    using (bucket_id = 'menu' and (select app.current_role()) in ('owner', 'manager')
           and (storage.foldername(name))[1] = (select app.current_branch_id())::text)
  $p$;
end $$;
