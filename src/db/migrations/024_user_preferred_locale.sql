alter table core.users
  add column if not exists preferred_locale text not null default 'en';

alter table core.users
  drop constraint if exists users_preferred_locale_chk;

alter table core.users
  add constraint users_preferred_locale_chk
  check (preferred_locale in ('en', 'cs', 'sk', 'de', 'fr', 'es'));

