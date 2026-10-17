# Rent Master

Rent Master is a static web application backed by Supabase. Landlords publish rental listings, invite tenants, share M-Pesa instructions and review receipt references. Tenants pay landlords directly and can track the landlord's review of submitted references.

## Launch status

This repository contains the application and backend integration, but it is **not live or ready to accept paying customers until the operator completes the configuration below**. No production Supabase project, Resend sender domain, site domain, customer-support address, subscription prices or legally approved policies are supplied in this repository.

Rent Master supports manual M-Pesa Till/Paybill instructions and landlord review of receipt references. It does not initiate, receive, hold or transfer money, and a submitted reference is not proof of payment.

## Configure Supabase

1. Create a Supabase project in the intended production region. Keep the service-role key private.
2. Copy the project URL and publishable (or legacy anon) key into `supabase-config.js`. These values are used by the browser; never put the service-role key or an email API key in that file.
3. Install the Supabase CLI, sign in, and link this project:

   ```powershell
   supabase login
   supabase link --project-ref YOUR_PROJECT_REF
   supabase db push
   ```

   The migration creates the profile, property, tenancy, payment, notification and rate-limit tables, row-level access policies, public listing view, profile/tenancy-link triggers, and restricted database functions.
4. In Supabase Auth settings, set the production Site URL and allow exact HTTPS redirect URLs for `login.html` and `reset-password.html`. Add local-development URLs only to a non-production project. Enable email confirmation and configure a verified custom SMTP sender for Auth confirmation and password-reset messages. Set a minimum password length of 12 characters and suitable provider rate limits.
5. Verify the project's Auth email templates and test email confirmation, password reset, role selection and tenant access with separate accounts.

## Configure email and deploy the server function

Create and verify a sending domain with Resend. Configure the matching SPF/DKIM DNS records, then set Supabase Edge Function secrets:

```powershell
supabase secrets set `
  SUPABASE_ANON_KEY=YOUR_PROJECT_PUBLISHABLE_OR_ANON_KEY `
  SUPABASE_SERVICE_ROLE_KEY=YOUR_PROJECT_SERVICE_ROLE_KEY `
  RESEND_API_KEY=YOUR_RESEND_API_KEY `
  EMAIL_FROM="Rent Master <notifications@YOUR_VERIFIED_DOMAIN>" `
  APP_URL="https://YOUR_PRODUCTION_DOMAIN"

supabase functions deploy rental-actions
```

`SUPABASE_URL` is supplied to hosted Supabase Edge Functions. `APP_URL` must be the exact HTTPS site origin. Configure Auth's SMTP separately even if it uses Resend: Edge Function emails use Resend's API, while Auth confirmation and reset messages use Supabase's SMTP configuration.

The `rental-actions` function verifies the caller's account and landlord/tenant role before creating tenant assignments, removing access, recording receipt references, or reviewing payments. It writes account notifications and sends transactional email. If email delivery fails after a data change has committed, the application reports that explicitly.

## Host the static site

Deploy the repository root to a static host with HTTPS. `_headers` provides baseline security headers for Netlify-compatible hosts. Keep `supabase-config.js` limited to the project URL and public publishable/anon key. Restrict Supabase Auth redirect URLs and email provider credentials to production domains.

## Required pre-sale work

- Replace `supabase-config.js` placeholders and deploy the database migration and Edge Function.
- Configure production Auth SMTP and a verified Resend sender; test tenant invitations, removals, payment updates, signup confirmation and password reset.
- Add the operator's legal name, registered contact and customer-support/privacy contact. Have local counsel review and complete the draft `terms.html` and `privacy.html` for the actual operator, service region, retention practices and applicable privacy/payment rules.
- Decide and publish subscription pricing, support availability, dispute and account-deletion procedures, backup/restore and incident-response practices.
- Add real, authorized listing photography and test the mobile experience, browser accessibility, email deliverability, abuse controls and backups.
- Treat Till/Paybill receipt confirmation as a manual record-keeping feature. Obtain specialist advice before advertising or adding any payment-collection, custody or automated-settlement functionality.

## Smoke-test checklist

After configuration and deployment, use separate verified landlord and tenant accounts:

1. Create a landlord account, register a property, and verify public listings show only the neighbourhood and listing fields—not the full address or payment instructions.
2. Register a new tenant. Confirm the access email arrives, then create and verify a tenant account with the same email.
3. Confirm the tenant can see only assigned active rentals, exact address and landlord payment instructions.
4. Submit a valid M-Pesa receipt reference; verify the landlord is notified and can confirm or reject it.
5. Confirm the tenant receives the decision by email and in-app notice. Remove the tenant and verify rental details are no longer available and the tenant is notified.
6. Attempt cross-account property, tenant, payment and notification access with another authenticated user; all unauthorized operations must be denied.
7. Test invalid, duplicate and rate-limited requests, delivery failures, mobile widths, and the production security headers.
