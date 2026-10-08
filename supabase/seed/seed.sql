-- The Slush Bar, Bahadurgarh: real branch details (Phase 1 §Business).
-- Phone, email and GSTIN are still to come from the owner; fill them in Admin → Settings.
insert into public.branches (slug, name, address, pincode, lat, lng)
values ('bahadurgarh-s6', 'The Slush Bar',
        'Shop No. 140, The Slush Bar, Market, Sector-6, Bahadurgarh, Haryana', '124507',
        null, null)
on conflict (slug) do nothing;

select app.ensure_branch_settings(id) from public.branches where slug = 'bahadurgarh-s6';

-- Every day 11:00–23:00.
insert into public.business_hours (branch_id, weekday, opens_at, closes_at)
select b.id, d, '11:00', '23:00'
from public.branches b, generate_series(0, 6) d
where b.slug = 'bahadurgarh-s6'
  and not exists (select 1 from public.business_hours h where h.branch_id = b.id);
