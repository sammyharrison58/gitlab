import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const resendApiKey = Deno.env.get("RESEND_API_KEY") ?? "";
const emailFrom = Deno.env.get("EMAIL_FROM") ?? "";
const appUrl = Deno.env.get("APP_URL") ?? "";

let allowedOrigin = "null";
try {
    if (appUrl) allowedOrigin = new URL(appUrl).origin;
} catch {
    allowedOrigin = "null";
}

const corsHeaders = {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin"
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
}

function escapeHtml(value: string) {
    return value.replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[character] ?? character);
}

function validateEnvironment() {
    const missing = [
        ["SUPABASE_URL", supabaseUrl],
        ["SUPABASE_ANON_KEY", anonKey],
        ["SUPABASE_SERVICE_ROLE_KEY", serviceRoleKey],
        ["RESEND_API_KEY", resendApiKey],
        ["EMAIL_FROM", emailFrom],
        ["APP_URL", appUrl]
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) {
        throw new Error("Missing required server configuration: " + missing.join(", "));
    }
    const parsedAppUrl = new URL(appUrl);
    if (parsedAppUrl.protocol !== "https:" && parsedAppUrl.hostname !== "localhost") {
        throw new Error("APP_URL must use HTTPS outside local development.");
    }
}

async function createNotification(
    admin: SupabaseClient,
    input: {
        email: string;
        userId: string | null;
        subject: string;
        message: string;
        actionPath?: string;
    }
) {
    const recipient = input.email.trim().toLowerCase();
    const { data: notice, error } = await admin.from("notifications")
        .insert({
            user_id: input.userId,
            recipient_email: recipient,
            subject: input.subject,
            message: input.message
        })
        .select("id")
        .single();
    if (error) throw new Error("The change could not be saved to the notification inbox: " + error.message);

    const escapedSubject = escapeHtml(input.subject);
    const escapedMessage = escapeHtml(input.message);
    const destination = new URL(input.actionPath ?? "/", appUrl);
    if (destination.origin !== new URL(appUrl).origin) {
        throw new Error("The notification destination must stay on the Rent Master site.");
    }
    const safeAppUrl = escapeHtml(destination.href);
    let emailResponse: Response;
    try {
        emailResponse = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
                "Authorization": "Bearer " + resendApiKey,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                from: emailFrom,
                to: [recipient],
                subject: input.subject,
                text: input.message + "\n\nVisit Rent Master: " + appUrl,
                html: "<!doctype html><html lang=\"en\"><body style=\"margin:0;padding:32px;background:#f4f6fb;font-family:Arial,sans-serif;color:#172033\">" +
                    "<main style=\"max-width:560px;margin:0 auto;padding:32px;background:#fff;border:1px solid #e2e8f0;border-radius:16px\">" +
                    "<p style=\"font-weight:700;color:#2563eb\">RENT MASTER</p><h1 style=\"font-size:22px\">" +
                    escapedSubject + "</h1><p style=\"line-height:1.7\">" + escapedMessage +
                    "</p><p><a href=\"" + safeAppUrl +
                    "\" style=\"display:inline-block;padding:12px 18px;border-radius:8px;background:#172033;color:#fff;text-decoration:none\">Open Rent Master</a></p>" +
                    "<p style=\"font-size:12px;color:#64748b\">This is an account notification from Rent Master.</p></main></body></html>"
            })
        });
    } catch (error) {
        const detail = error instanceof Error ? error.message : "Network error";
        console.error("Resend request failed.", detail);
        const { error: logError } = await admin.from("notifications")
            .update({ email_error: detail.slice(0, 500) })
            .eq("id", notice.id);
        if (logError) console.error("Could not record the email delivery failure.", logError.message);
        return { emailSent: false, notificationId: notice.id };
    }

    if (!emailResponse.ok) {
        const providerMessage = (await emailResponse.text()).slice(0, 500);
        const { error: logError } = await admin.from("notifications")
            .update({ email_error: "Email provider returned " + emailResponse.status + ": " + providerMessage })
            .eq("id", notice.id);
        if (logError) console.error("Could not record the email delivery failure.", logError.message);
        return { emailSent: false, notificationId: notice.id };
    }

    const { error: sentUpdateError } = await admin.from("notifications")
        .update({ email_sent_at: new Date().toISOString(), email_error: null })
        .eq("id", notice.id);
    if (sentUpdateError) {
        console.error("Email was delivered but its delivery timestamp could not be saved.", sentUpdateError.message);
    }
    return { emailSent: true, notificationId: notice.id };
}

function responseForEmailResult(result: { emailSent: boolean; notificationId: string }) {
    if (!result.emailSent) {
        return jsonResponse({
            error: "The account change was saved, but the notification email was not delivered. Check the email provider configuration.",
            committed: true,
            notificationId: result.notificationId
        }, 502);
    }
    return jsonResponse({ success: true, emailSent: true, notificationId: result.notificationId });
}

async function enforceRateLimit(
    admin: SupabaseClient,
    subject: string,
    action: string,
    maximum: number,
    windowSeconds: number
) {
    const { data, error } = await admin.rpc("check_rental_action_limit", {
        p_subject: subject,
        p_action: action,
        p_max_requests: maximum,
        p_window_seconds: windowSeconds
    });
    if (error) {
        console.error("Rental action rate-limit check failed.", error.message);
        return jsonResponse({ error: "This action is temporarily unavailable. Please try again shortly." }, 503);
    }
    if (!data) return jsonResponse({ error: "Too many requests. Please wait before trying again." }, 429);
    return null;
}

Deno.serve(async (request) => {
    if (request.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }
    if (request.method !== "POST") {
        return jsonResponse({ error: "Use POST for rental actions." }, 405);
    }

    try {
        validateEnvironment();
    } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : "Server configuration is incomplete." }, 503);
    }

    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(appUrl).origin) {
        return jsonResponse({ error: "This site is not allowed to access the rental service." }, 403);
    }

    const authorization = request.headers.get("Authorization") ?? "";
    const token = authorization.replace(/^Bearer\s+/i, "");
    if (!token) return jsonResponse({ error: "Sign in to continue." }, 401);

    let body: Record<string, unknown>;
    try {
        const parsed = await request.json();
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return jsonResponse({ error: "The request body must be a JSON object." }, 400);
        }
        body = parsed as Record<string, unknown>;
    } catch {
        return jsonResponse({ error: "The request body is not valid JSON." }, 400);
    }

    const auth = createClient(supabaseUrl, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: authorization } }
    });
    const { data: userResult, error: authError } = await auth.auth.getUser(token);
    if (authError || !userResult.user || !userResult.user.email_confirmed_at) {
        return jsonResponse({ error: "A verified account is required. Check your inbox to verify your email, then sign in again." }, 401);
    }

    const actor = userResult.user;
    const admin = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data: profile, error: profileError } = await admin.from("profiles")
        .select("id, email, full_name, role")
        .eq("id", actor.id)
        .single();
    if (profileError || !profile) {
        return jsonResponse({ error: "Your account profile is unavailable. Contact support." }, 403);
    }

    const action = body.action;

    if (action === "register_tenant") {
        if (profile.role !== "landlord") return jsonResponse({ error: "Only landlords can register tenants." }, 403);
        const propertyId = typeof body.propertyId === "string" ? body.propertyId : "";
        const tenantEmail = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        const tenantName = typeof body.name === "string" ? body.name.trim() : "";
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(propertyId)) {
            return jsonResponse({ error: "Choose a valid property." }, 400);
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(tenantEmail) || tenantEmail.length > 254) {
            return jsonResponse({ error: "Enter a valid tenant email address." }, 400);
        }
        if (!tenantName || tenantName.length > 100) {
            return jsonResponse({ error: "Enter the tenant's name (up to 100 characters)." }, 400);
        }
        const actorLimit = await enforceRateLimit(admin, actor.id, "register_tenant_actor", 10, 3600);
        if (actorLimit) return actorLimit;
        const recipientLimit = await enforceRateLimit(admin, tenantEmail, "register_tenant_recipient", 2, 86400);
        if (recipientLimit) return recipientLimit;
        const { data: property, error: propertyError } = await admin.from("properties")
            .select("id, name")
            .eq("id", propertyId)
            .eq("landlord_id", actor.id)
            .is("archived_at", null)
            .maybeSingle();
        if (propertyError || !property) return jsonResponse({ error: "That property is not available in your account." }, 404);

        const { data: existingProfile, error: existingProfileError } = await admin.from("profiles")
            .select("id, role, email_verified_at")
            .eq("email", tenantEmail)
            .maybeSingle();
        if (existingProfileError) return jsonResponse({ error: "Could not check the tenant account." }, 500);
        if (existingProfile && existingProfile.role !== "tenant") {
            return jsonResponse({ error: "This email belongs to an account registered with a different role." }, 409);
        }
        const { data: existingTenancy, error: existingError } = await admin.from("tenancies")
            .select("id")
            .eq("property_id", property.id)
            .eq("tenant_email", tenantEmail)
            .in("status", ["invited", "active"])
            .maybeSingle();
        if (existingError) return jsonResponse({ error: "Could not check current tenant access." }, 500);
        if (existingTenancy) return jsonResponse({ error: "This tenant already has current access to that property." }, 409);

        const { data: tenancy, error: insertError } = await admin.from("tenancies")
            .insert({
                property_id: property.id,
                landlord_id: actor.id,
                tenant_id: existingProfile?.email_verified_at ? existingProfile.id : null,
                tenant_email: tenantEmail,
                tenant_name: tenantName,
                status: existingProfile?.email_verified_at ? "active" : "invited"
            })
            .select("id")
            .single();
        if (insertError || !tenancy) {
            return jsonResponse({ error: "Tenant registration could not be saved. Please try again." }, 500);
        }

        try {
            const emailResult = await createNotification(admin, {
                email: tenantEmail,
                userId: existingProfile?.email_verified_at ? existingProfile.id : null,
                subject: "Your Rent Master tenant access",
                message: profile.full_name + " added you to " + property.name +
                    ". " + (existingProfile?.email_verified_at
                        ? "Sign in to view your rental details."
                        : "Create a Rent Master tenant account using this email address and verify it to access your rental."),
                actionPath: existingProfile?.email_verified_at
                    ? "/login.html"
                    : "/signup.html?role=tenant&email=" + encodeURIComponent(tenantEmail)
            });
            return responseForEmailResult(emailResult);
        } catch (error) {
            console.error("Tenant was registered, but notification delivery failed.", error);
            return jsonResponse({
                error: "The tenant was registered, but the notification could not be sent. Check the email service and notify the tenant directly.",
                committed: true,
                tenancyId: tenancy.id
            }, 502);
        }
    }

    if (action === "remove_tenant") {
        if (profile.role !== "landlord") return jsonResponse({ error: "Only landlords can remove tenants." }, 403);
        const tenancyId = typeof body.tenancyId === "string" ? body.tenancyId : "";
        const rateLimit = await enforceRateLimit(admin, actor.id, "remove_tenant", 20, 3600);
        if (rateLimit) return rateLimit;
        const { data: tenancy, error: tenancyError } = await admin.from("tenancies")
            .select("id, tenant_id, tenant_email, tenant_name, property_id")
            .eq("id", tenancyId)
            .eq("landlord_id", actor.id)
            .eq("status", "active")
            .maybeSingle();
        if (tenancyError || !tenancy) return jsonResponse({ error: "That active tenant was not found in your account." }, 404);
        const { data: property } = await admin.from("properties")
            .select("name")
            .eq("id", tenancy.property_id)
            .maybeSingle();
        const { error: updateError } = await admin.from("tenancies")
            .update({ status: "removed", removed_at: new Date().toISOString() })
            .eq("id", tenancy.id)
            .eq("landlord_id", actor.id);
        if (updateError) return jsonResponse({ error: "Tenant access could not be removed. Please try again." }, 500);
        try {
            const emailResult = await createNotification(admin, {
                email: tenancy.tenant_email,
                userId: tenancy.tenant_id,
                subject: "Your Rent Master tenant access has changed",
                message: "Your access to " + (property?.name ?? "the rental property") +
                    " has been removed by the landlord. Contact the landlord if you believe this is an error."
            });
            return responseForEmailResult(emailResult);
        } catch (error) {
            console.error("Tenant access was removed, but notification delivery failed.", error);
            return jsonResponse({
                error: "Tenant access was removed, but the notification could not be sent. Check the email service.",
                committed: true,
                tenancyId: tenancy.id
            }, 502);
        }
    }

    if (action === "submit_payment") {
        if (profile.role !== "tenant") return jsonResponse({ error: "Only tenants can submit rent references." }, 403);
        const propertyId = typeof body.propertyId === "string" ? body.propertyId : "";
        const rentMonth = typeof body.rentMonth === "string" ? body.rentMonth : "";
        const reference = typeof body.reference === "string" ? body.reference.trim().toUpperCase() : "";
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(propertyId)) {
            return jsonResponse({ error: "Choose a valid rental property." }, 400);
        }
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(rentMonth)) {
            return jsonResponse({ error: "Select a valid rent month." }, 400);
        }
        if (!/^[A-Z0-9]{8,12}$/.test(reference)) {
            return jsonResponse({ error: "Enter a valid 8–12 character M-Pesa receipt reference." }, 400);
        }
        const rateLimit = await enforceRateLimit(admin, actor.id, "submit_payment", 6, 3600);
        if (rateLimit) return rateLimit;
        const { data: tenancy, error: tenancyError } = await admin.from("tenancies")
            .select("id, landlord_id, property_id")
            .eq("tenant_id", actor.id)
            .eq("property_id", propertyId)
            .eq("status", "active")
            .maybeSingle();
        if (tenancyError || !tenancy) return jsonResponse({ error: "You do not have active access to that rental." }, 403);
        const { data: property, error: propertyError } = await admin.from("properties")
            .select("name, rent_kes")
            .eq("id", propertyId)
            .is("archived_at", null)
            .single();
        if (propertyError || !property) return jsonResponse({ error: "The property is no longer available." }, 404);
        const { data: payment, error: paymentError } = await admin.from("rent_payments")
            .insert({
                property_id: propertyId,
                landlord_id: tenancy.landlord_id,
                tenant_id: actor.id,
                tenancy_id: tenancy.id,
                rent_month: rentMonth + "-01",
                amount_kes: property.rent_kes,
                mpesa_reference: reference
            })
            .select("id")
            .single();
        if (paymentError) {
            return jsonResponse({
                error: paymentError.code === "23505"
                    ? "A payment for that month or M-Pesa receipt reference has already been submitted."
                    : "The payment reference could not be saved. Please try again."
            }, paymentError.code === "23505" ? 409 : 500);
        }
        try {
            const { data: landlord } = await admin.from("profiles")
                .select("email")
                .eq("id", tenancy.landlord_id)
                .single();
            if (!landlord) throw new Error("The landlord notification recipient was not found.");
            const emailResult = await createNotification(admin, {
                email: landlord.email,
                userId: tenancy.landlord_id,
                subject: "A rent payment reference needs review",
                message: profile.full_name + " submitted M-Pesa reference " + reference +
                    " for " + property.name + " (" + rentMonth + "). Verify the receipt against your M-Pesa statement."
            });
            return responseForEmailResult(emailResult);
        } catch (error) {
            console.error("Payment reference was saved, but the landlord notification failed.", error);
            return jsonResponse({
                error: "The reference was saved, but the landlord could not be notified. Contact the landlord directly.",
                committed: true,
                paymentId: payment.id
            }, 502);
        }
    }

    if (action === "review_payment") {
        if (profile.role !== "landlord") return jsonResponse({ error: "Only landlords can review rent references." }, 403);
        const paymentId = typeof body.paymentId === "string" ? body.paymentId : "";
        const decision = body.decision;
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(paymentId)) {
            return jsonResponse({ error: "Choose a valid payment record." }, 400);
        }
        if (decision !== "confirmed" && decision !== "rejected") {
            return jsonResponse({ error: "Choose whether to confirm or reject the payment reference." }, 400);
        }
        const rateLimit = await enforceRateLimit(admin, actor.id, "review_payment", 60, 3600);
        if (rateLimit) return rateLimit;
        const { data: payment, error: paymentError } = await admin.from("rent_payments")
            .select("id, property_id, tenant_id, tenant:profiles!rent_payments_tenant_id_fkey(email), property:properties!rent_payments_property_id_fkey(name)")
            .eq("id", paymentId)
            .eq("landlord_id", actor.id)
            .eq("status", "pending")
            .maybeSingle();
        if (paymentError || !payment) return jsonResponse({ error: "That pending payment was not found in your account." }, 404);
        const { error: updateError } = await admin.from("rent_payments")
            .update({ status: decision, reviewed_at: new Date().toISOString() })
            .eq("id", payment.id)
            .eq("landlord_id", actor.id)
            .eq("status", "pending");
        if (updateError) return jsonResponse({ error: "The payment could not be reviewed. Please try again." }, 500);
        try {
            const emailResult = await createNotification(admin, {
                email: payment.tenant.email,
                userId: payment.tenant_id,
                subject: decision === "confirmed" ? "Your rent payment was confirmed" : "Your rent payment needs attention",
                message: decision === "confirmed"
                    ? "Your landlord confirmed the M-Pesa payment for " + payment.property.name + "."
                    : "Your landlord could not confirm the M-Pesa reference for " + payment.property.name +
                        ". Please contact your landlord and check the receipt details."
            });
            return responseForEmailResult(emailResult);
        } catch (error) {
            console.error("Payment review was saved, but tenant notification failed.", error);
            return jsonResponse({
                error: "The payment review was saved, but the tenant could not be notified. Contact the tenant directly.",
                committed: true,
                paymentId: payment.id
            }, 502);
        }
    }

    return jsonResponse({ error: "Unknown rental action." }, 400);
});
