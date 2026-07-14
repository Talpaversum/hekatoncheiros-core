alter table core.app_update_signals
  add column if not exists signature_jws text,
  add column if not exists author_cert_jws text,
  add column if not exists verified_author_id text,
  add column if not exists signature_expires_at timestamptz;

alter table core.app_update_signals
  drop constraint if exists app_update_signals_signature_material_chk;

alter table core.app_update_signals
  add constraint app_update_signals_signature_material_chk check (
    (signature_jws is null and author_cert_jws is null and verified_author_id is null and signature_expires_at is null)
    or
    (signature_jws is not null and author_cert_jws is not null and verified_author_id is not null and signature_expires_at is not null)
  );
