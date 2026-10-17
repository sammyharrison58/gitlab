create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table public.profiles (
    id uuid primary key references auth.users (id) on delete cascade,
    email text not null unique,
    email_verified_at timestamptz,
    full_name text not null,
    role text not null check (role in ('landlord', 'tenant')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table public.properties (
    id uuid primary key default extensions.gen_random_uuid(),
    landlord_id uuid not null references public.profiles (id) on delete restrict,
    name text not null check (char_length(name) between 1 and 100),
    public_area text not null check (char_length(public_area) between 1 and 160),
    exact_address text not null check (char_length(exact_address) between 1 and 240),
    rent_kes integer not null check (rent_kes between 1 and 1000000000),
    payment_type text not null check (payment_type in ('Till', 'Paybill')),
    payment_number text not null check (payment_number ~ '^[0-9]{5,30}$'),
    payment_account text not null check (char_length(payment_account) between 1 and 100),
    description text not null default '' check (char_length(description) <= 2000),
    bedrooms smallint check (bedrooms between 0 and 100),
    bathrooms smallint check (bathrooms between 0 and 100),
    image_url text check (
        image_url is null
        or (char_length(image_url) <= 2048 and image_url ~ '^https://')
    ),
    is_listed boolean not null default false,
    archived_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table public.tenancies (
    id uuid primary key default extensions.gen_random_uuid(),
    property_id uuid not null references public.properties (id) on delete restrict,
    landlord_id uuid not null references public.profiles (id) on delete restrict,
    tenant_id uuid references public.profiles (id) on delete set null,
    tenant_email text not null check (tenant_email = lower(btrim(tenant_email))),
    tenant_name text not null check (char_length(tenant_name) between 1 and 100),
    status text not null default 'invited' check (status in ('invited', 'active', 'removed')),
    created_at timestamptz not null default now(),
    removed_at timestamptz,
    check ((status = 'removed') = (removed_at is not null)),
    check (status <> 'active' or tenant_id is not null),
    check (status <> 'invited' or tenant_id is null)
);

create unique index tenancies_one_live_email_per_property
    on public.tenancies (property_id, tenant_email)
    where status in ('invited', 'active');

create index tenancies_tenant_active
    on public.tenancies (tenant_id, status);

create index tenancies_landlord_created
    on public.tenancies (landlord_id, created_at desc);

create table public.rent_payments (
    id uuid primary key default extensions.gen_random_uuid(),
    property_id uuid not null references public.properties (id) on delete restrict,
    landlord_id uuid not null references public.profiles (id) on delete restrict,
    tenant_id uuid not null references public.profiles (id) on delete restrict,
    tenancy_id uuid not null references public.tenancies (id) on delete restrict,
    rent_month date not null check (extract(day from rent_month) = 1),
    amount_kes integer not null check (amount_kes between 1 and 1000000000),
    mpesa_reference text not null check (mpesa_reference ~ '^[A-Z0-9]{8,12}$'),
    status text not null default 'pending' check (status in ('pending', 'confirmed', 'rejected')),
    created_at timestamptz not null default now(),
    reviewed_at timestamptz,
    check ((status = 'pending') = (reviewed_at is null))
);

create unique index rent_payments_one_active_receipt_per_month
    on public.rent_payments (tenancy_id, rent_month)
    where status in ('pending', 'confirmed');

create unique index rent_payments_unique_mpesa_reference
    on public.rent_payments (upper(mpesa_reference));

create index rent_payments_landlord_created
    on public.rent_payments (landlord_id, created_at desc);

create table public.notifications (
    id uuid primary key default extensions.gen_random_uuid(),
    user_id uuid references public.profiles (id) on delete set null,
    recipient_email text not null check (recipient_email = lower(btrim(recipient_email))),
    subject text not null check (char_length(subject) between 1 and 160),
    message text not null check (char_length(message) between 1 and 2000),
    email_sent_at timestamptz,
    email_error text,
    created_at timestamptz not null default now()
);

create index notifications_user_created
    on public.notifications (user_id, created_at desc);

create table public.rental_action_buckets (
    subject_hash text not null,
    action text not null,
    window_start bigint not null,
    request_count integer not null check (request_count > 0),
    expires_at timestamptz not null,
    primary key (subject_hash, action, window_start)
);

grant all on table public.profiles,
    public.properties,
    public.tenancies,
    public.rent_payments,
    public.notifications,
    public.rental_action_buckets to service_role;

create index rental_action_buckets_expires
    on public.rental_action_buckets (expires_at);

alter table public.rental_action_buckets enable row level security;

create or replace function public.check_rental_action_limit(
    p_subject text,
    p_action text,
    p_max_requests integer,
    p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    selected_window bigint;
begin
    if p_subject is null or length(p_subject) > 320
       or p_action not in (
            'register_tenant_actor',
            'register_tenant_recipient',
            'remove_tenant',
            'submit_payment',
            'review_payment'
       )
       or p_max_requests < 1 or p_max_requests > 100
       or p_window_seconds < 1 or p_window_seconds > 86400 then
        return false;
    end if;

    selected_window := floor(extract(epoch from clock_timestamp()) / p_window_seconds)::bigint;

    delete from public.rental_action_buckets
    where expires_at < clock_timestamp();

    insert into public.rental_action_buckets (
        subject_hash,
        action,
        window_start,
        request_count,
        expires_at
    )
    values (
        encode(extensions.digest(lower(btrim(p_subject)), 'sha256'), 'hex'),
        p_action,
        selected_window,
        1,
        clock_timestamp() + make_interval(secs => p_window_seconds)
    )
    on conflict (subject_hash, action, window_start)
    do update set request_count = rental_action_buckets.request_count + 1
    where rental_action_buckets.request_count < p_max_requests;

    return found;
end;
$$;

revoke all on public.rental_action_buckets from public, anon, authenticated;
revoke all on function public.check_rental_action_limit(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.check_rental_action_limit(text, text, integer, integer) to service_role;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create trigger properties_set_updated_at
before update on public.properties
for each row execute function public.set_updated_at();

create or replace function public.handle_auth_user_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    selected_role text;
    selected_name text;
begin
    selected_role := case
        when new.raw_user_meta_data ->> 'role' = 'landlord' then 'landlord'
        else 'tenant'
    end;
    selected_name := nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), '');

    insert into public.profiles (id, email, email_verified_at, full_name, role)
    values (
        new.id,
        lower(new.email),
        new.email_confirmed_at,
        coalesce(selected_name, 'Rent Master user'),
        selected_role
    )
    on conflict (id) do update
    set email = excluded.email,
        email_verified_at = excluded.email_verified_at;

    if new.email_confirmed_at is not null and selected_role = 'tenant' then
        update public.tenancies
        set tenant_id = new.id,
            status = 'active'
        where tenant_id is null
          and status = 'invited'
          and tenant_email = lower(new.email);
    end if;

    if new.email_confirmed_at is not null then
        update public.notifications
        set user_id = new.id
        where user_id is null
          and recipient_email = lower(new.email);
    end if;

    return new;
end;
$$;

create trigger auth_user_added
after insert on auth.users
for each row execute function public.handle_auth_user_change();

create trigger auth_user_changed
after update of email, email_confirmed_at, raw_user_meta_data on auth.users
for each row execute function public.handle_auth_user_change();

alter table public.profiles enable row level security;
alter table public.properties enable row level security;
alter table public.tenancies enable row level security;
alter table public.rent_payments enable row level security;
alter table public.notifications enable row level security;

create policy profiles_read_own
    on public.profiles for select to authenticated
    using (id = (select auth.uid()));

create policy properties_read_public_listings
    on public.properties for select to anon, authenticated
    using (is_listed and archived_at is null);

create policy properties_read_landlord
    on public.properties for select to authenticated
    using (landlord_id = (select auth.uid()));

create policy properties_read_tenant
    on public.properties for select to authenticated
    using (
        exists (
            select 1
            from public.tenancies t
            where t.property_id = properties.id
              and t.tenant_id = (select auth.uid())
              and t.status = 'active'
        )
    );

create policy properties_insert_landlord
    on public.properties for insert to authenticated
    with check (
        landlord_id = (select auth.uid())
        and exists (
            select 1 from public.profiles p
            where p.id = (select auth.uid())
              and p.role = 'landlord'
              and p.email_verified_at is not null
        )
    );

create policy properties_update_landlord
    on public.properties for update to authenticated
    using (
        landlord_id = (select auth.uid())
        and exists (
            select 1 from public.profiles p
            where p.id = (select auth.uid())
              and p.role = 'landlord'
              and p.email_verified_at is not null
        )
    )
    with check (
        landlord_id = (select auth.uid())
        and exists (
            select 1 from public.profiles p
            where p.id = (select auth.uid())
              and p.role = 'landlord'
              and p.email_verified_at is not null
        )
    );

create policy tenancies_read_participant
    on public.tenancies for select to authenticated
    using (
        landlord_id = (select auth.uid())
        or (tenant_id = (select auth.uid()) and status = 'active')
    );

create policy payments_read_participant
    on public.rent_payments for select to authenticated
    using (
        landlord_id = (select auth.uid())
        or tenant_id = (select auth.uid())
    );

create policy notifications_read_own
    on public.notifications for select to authenticated
    using (user_id = (select auth.uid()));

revoke all on public.profiles from anon, authenticated;
revoke all on public.properties from anon, authenticated;
revoke all on public.tenancies from anon, authenticated;
revoke all on public.rent_payments from anon, authenticated;
revoke all on public.notifications from anon, authenticated;

grant select (id, email, email_verified_at, full_name, role, created_at)
    on public.profiles to authenticated;

grant select (
    id, name, public_area, rent_kes, description,
    bedrooms, bathrooms, image_url, is_listed, archived_at, created_at, updated_at
) on public.properties to anon, authenticated;

grant insert (
    landlord_id, name, public_area, exact_address, rent_kes, payment_type,
    payment_number, payment_account, description, bedrooms, bathrooms,
    image_url, is_listed
) on public.properties to authenticated;

grant update (
    name, public_area, exact_address, rent_kes, payment_type,
    payment_number, payment_account, description, bedrooms, bathrooms,
    image_url, is_listed, archived_at
) on public.properties to authenticated;

grant select (id, property_id, landlord_id, tenant_id, tenant_email, tenant_name, status, created_at, removed_at)
    on public.tenancies to authenticated;

grant select (
    id, property_id, landlord_id, tenant_id, tenancy_id, rent_month,
    amount_kes, mpesa_reference, status, created_at, reviewed_at
) on public.rent_payments to authenticated;

grant select (id, user_id, recipient_email, subject, message, email_sent_at, created_at)
    on public.notifications to authenticated;

create or replace view public.public_property_listings
with (security_invoker = true)
as
select
    id,
    name,
    public_area,
    rent_kes,
    description,
    bedrooms,
    bathrooms,
    image_url,
    created_at
from public.properties
where is_listed and archived_at is null;

grant select on public.public_property_listings to anon, authenticated;

create or replace function public.get_managed_properties()
returns setof public.properties
language sql
stable
security definer
set search_path = ''
as $$
    select p.*
    from public.properties p
    join public.profiles profile on profile.id = (select auth.uid())
    where p.landlord_id = (select auth.uid())
      and profile.role = 'landlord'
      and profile.email_verified_at is not null
      and p.archived_at is null
    order by p.created_at desc;
$$;

create or replace function public.get_my_rental_properties()
returns table (
    tenancy_id uuid,
    property_id uuid,
    property_name text,
    public_area text,
    exact_address text,
    rent_kes integer,
    payment_type text,
    payment_number text,
    payment_account text,
    landlord_id uuid
)
language sql
stable
security definer
set search_path = ''
as $$
    select
        t.id,
        p.id,
        p.name,
        p.public_area,
        p.exact_address,
        p.rent_kes,
        p.payment_type,
        p.payment_number,
        p.payment_account,
        p.landlord_id
    from public.tenancies t
    join public.properties p on p.id = t.property_id
    join public.profiles profile on profile.id = (select auth.uid())
    where t.tenant_id = (select auth.uid())
      and t.status = 'active'
      and p.archived_at is null
      and profile.role = 'tenant'
      and profile.email_verified_at is not null
    order by t.created_at desc;
$$;

revoke all on function public.get_managed_properties() from public, anon;
revoke all on function public.get_my_rental_properties() from public, anon;
grant execute on function public.get_managed_properties() to authenticated;
grant execute on function public.get_my_rental_properties() to authenticated;
