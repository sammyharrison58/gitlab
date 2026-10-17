(function () {
    const config = window.RENT_MASTER_CONFIG || {};
    let validUrl = false;
    try {
        const url = new URL(config.supabaseUrl);
        validUrl = (url.protocol === 'https:' || url.hostname === 'localhost') &&
            !url.hostname.includes('YOUR_PROJECT_REF');
    } catch {
        validUrl = false;
    }
    const ready = Boolean(
        window.supabase &&
        validUrl &&
        typeof config.supabaseAnonKey === 'string' &&
        config.supabaseAnonKey.length > 20 &&
        !config.supabaseAnonKey.includes('YOUR_SUPABASE')
    );

    let client;
    if (ready && window.supabase) {
        client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
            auth: {
                autoRefreshToken: true,
                persistSession: true,
                detectSessionInUrl: true
            }
        });
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
            return {
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;'
            }[character];
        });
    }

    function setStatus(element, message, state) {
        if (!element) return;
        element.textContent = message;
        element.dataset.state = state || 'error';
    }

    function currency(amount) {
        return new Intl.NumberFormat('en-KE', {
            style: 'currency',
            currency: 'KES',
            maximumFractionDigits: 0
        }).format(Number(amount) || 0);
    }

    function dateTime(value) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('en-KE');
    }

    function currentMonth() {
        const date = new Date();
        return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
    }

    function safeImageUrl(value) {
        if (!value) return '';
        try {
            const url = new URL(value, window.location.origin);
            if (url.protocol !== 'https:' && url.origin !== window.location.origin) return '';
            if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
            return url.href;
        } catch {
            return '';
        }
    }

    function propertyCard(property, options) {
        const listing = Boolean(options && options.listing);
        const imageUrl = safeImageUrl(property.image_url);
        const image = imageUrl
            ? '<img src="' + escapeHtml(imageUrl) + '" alt="' + escapeHtml(property.title || property.name) + '" loading="lazy">'
            : '<div class="listing-image-placeholder" role="img" aria-label="No property image available">RM</div>';
        const heading = property.title || property.name;
        const description = property.description || 'Contact the landlord for more information.';
        return '<article class="home-property-card production-property-card">' +
            image +
            '<div class="home-property-copy">' +
            '<p class="property-location">' + escapeHtml(property.public_area || property.address || 'Kenya') + '</p>' +
            '<h3>' + escapeHtml(heading) + '</h3>' +
            '<p>' + escapeHtml(description) + '</p>' +
            '<div class="listing-meta">' +
            (property.bedrooms == null ? '' : '<span>' + escapeHtml(property.bedrooms) + ' beds</span>') +
            (property.bathrooms == null ? '' : '<span>' + escapeHtml(property.bathrooms) + ' baths</span>') +
            '</div>' +
            '<p class="production-property-price">' + escapeHtml(currency(property.rent_kes || property.rent)) + '<span> / month</span></p>' +
            (listing ? '<a class="text-link" href="signup.html?role=tenant">Create a tenant account &rarr;</a>' : '') +
            '</div></article>';
    }

    window.RentMaster = {
        ready: ready,
        client: client,
        escapeHtml: escapeHtml,
        safeImageUrl: safeImageUrl,
        setStatus: setStatus,
        currency: currency,
        dateTime: dateTime,
        currentMonth: currentMonth,
        propertyCard: propertyCard,
        dashboardPath: function (role) {
            return role === 'landlord' ? 'Landlords.html' : 'tenant-dashboard.html';
        },
        async requireProfile(expectedRole) {
            if (!ready || !client) {
                throw new Error('Rent Master is not connected to Supabase yet. Follow the deployment setup before creating accounts.');
            }
            const { data: { user }, error: userError } = await client.auth.getUser();
            if (userError || !user) {
                window.location.replace('login.html');
                return null;
            }
            const { data: profile, error } = await client
                .from('profiles')
                .select('id, full_name, email, role, email_verified_at')
                .eq('id', user.id)
                .single();
            if (error) throw error;
            if (!profile.email_verified_at) {
                await client.auth.signOut();
                window.location.replace('login.html?verification=required');
                return null;
            }
            if (expectedRole && profile.role !== expectedRole) {
                window.location.replace(this.dashboardPath(profile.role));
                return null;
            }
            return { user: user, profile: profile };
        },
        async invoke(action, payload) {
            if (!client) throw new Error('Rent Master has not been connected to Supabase.');
            const { data, error } = await client.functions.invoke('rental-actions', {
                body: Object.assign({ action: action }, payload || {})
            });
            if (error) {
                let detail = error.message;
                if (error.context && typeof error.context.json === 'function') {
                    const response = await error.context.json().catch(function () { return null; });
                    if (response && response.error) detail = response.error;
                    if (response && response.committed) {
                        detail += ' The change was saved, but its email could not be delivered.';
                    }
                }
                throw new Error(detail || 'The request could not be completed.');
            }
            if (data && data.error) {
                throw new Error(data.error);
            }
            return data;
        },
        getConfigurationMessage() {
            return 'This site is not connected to its production account service yet. Complete the Supabase deployment setup before continuing.';
        }
    };

    document.addEventListener('DOMContentLoaded', function () {
        document.querySelectorAll('[data-requires-backend]').forEach(function (element) {
            if (ready && client) return;
            element.hidden = false;
            element.setAttribute('role', 'status');
            element.textContent = window.RentMaster.getConfigurationMessage();
        });
    });
}());
