do $$
begin
  if exists (
    select 1
    from core.author_profiles
    where operating_mode = 'private_self_hosted'
  ) then
    raise exception using
      errcode = 'check_violation',
      message = 'Cannot remove private_self_hosted: an approved author profile still uses the legacy mode';
  end if;
end $$;

alter table core.author_requests
  drop constraint if exists author_requests_status_check;

alter table core.author_requests
  add constraint author_requests_status_check
  check (status in ('draft','submitted','pending_review','needs_changes','approved','rejected','suspended','revoked','invalid_mode'));

update core.author_requests
set status = 'invalid_mode',
    review_notes = concat_ws(E'\n', nullif(review_notes, ''), 'Invalidated during migration: private application development is not an author operating mode.'),
    updated_at = now()
where operating_mode = 'private_self_hosted';

alter table core.author_requests
  drop constraint if exists author_requests_operating_mode_check;

alter table core.author_requests
  add constraint author_requests_operating_mode_check
  check (operating_mode in ('talpaversum_hosted','trusted_self_hosted'));

alter table core.author_profiles
  drop constraint if exists author_profiles_operating_mode_check;

alter table core.author_profiles
  add constraint author_profiles_operating_mode_check
  check (operating_mode in ('talpaversum_hosted','trusted_self_hosted'));
