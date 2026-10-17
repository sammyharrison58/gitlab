document.addEventListener('DOMContentLoaded', async function () {
    const app = window.RentMaster;
    const pageMessage = document.getElementById('dashboard-message');
    const propertyForm = document.getElementById('property-form');
    const tenantForm = document.getElementById('tenant-form');
    const propertyList = document.getElementById('property-list');
    const tenantList = document.getElementById('tenant-list');
    const paymentList = document.getElementById('payment-list');
    let profile;
    let properties = [];

    function element(tag, text, className) {
        const node = document.createElement(tag);
        if (text !== undefined && text !== null) node.textContent = text;
        if (className) node.className = className;
        return node;
    }

    function cell(row, value) {
        const node = element('td', value);
        row.appendChild(node);
        return node;
    }

    function clearAndToggleEmpty(container, emptyId, hasRecords) {
        container.replaceChildren();
        document.getElementById(emptyId).hidden = hasRecords;
    }

    async function loadDashboard() {
        const [propertyResult, tenancyResult, paymentResult, noticeResult] = await Promise.all([
            app.client.rpc('get_managed_properties'),
            app.client.from('tenancies')
                .select('id, tenant_email, tenant_name, status, property_id, created_at, properties(name, rent_kes)')
                .order('created_at', { ascending: false }),
            app.client.from('rent_payments')
                .select('id, property_id, rent_month, amount_kes, mpesa_reference, status, created_at, tenancies(tenant_name, tenant_email), properties(name)')
                .order('created_at', { ascending: false }),
            app.client.from('notifications')
                .select('id, subject, message, created_at, email_sent_at')
                .order('created_at', { ascending: false })
                .limit(20)
        ]);
        const failure = [propertyResult, tenancyResult, paymentResult, noticeResult].find(function (result) {
            return result.error;
        });
        if (failure) throw failure.error;

        properties = propertyResult.data || [];
        const tenancies = tenancyResult.data || [];
        const payments = paymentResult.data || [];
        const notices = noticeResult.data || [];
        const activeTenancies = tenancies.filter(function (tenancy) {
            return tenancy.status === 'active';
        });
        const pendingPayments = payments.filter(function (payment) {
            return payment.status === 'pending';
        });
        const currentMonth = app.currentMonth();
        const confirmedTotal = payments.filter(function (payment) {
            return payment.status === 'confirmed' &&
                String(payment.rent_month).slice(0, 7) === currentMonth;
        }).reduce(function (total, payment) {
            return total + Number(payment.amount_kes);
        }, 0);

        document.getElementById('property-count').textContent = String(properties.length);
        document.getElementById('tenant-count').textContent = String(activeTenancies.length);
        document.getElementById('pending-count').textContent = String(pendingPayments.length);
        document.getElementById('confirmed-total').textContent = app.currency(confirmedTotal);

        clearAndToggleEmpty(propertyList, 'property-list-empty', properties.length > 0);
        properties.forEach(function (property) {
            const card = element('article', null, 'management-property-card');
            card.appendChild(element('h3', property.name));
            card.appendChild(element('p', property.public_area, 'tenant-meta'));
            card.appendChild(element('p', property.exact_address, 'management-property-payment'));
            card.appendChild(element('p', app.currency(property.rent_kes) + ' / month', 'management-property-rent'));
            card.appendChild(element(
                'p',
                property.payment_type + ': ' + property.payment_number + ' · ' + property.payment_account,
                'management-property-payment'
            ));
            const status = element('span', property.is_listed ? 'Listed publicly' : 'Private listing',
                'status-badge ' + (property.is_listed ? 'status-paid' : 'status-pending'));
            card.appendChild(status);
            const listingButton = element('button', property.is_listed ? 'Unpublish listing' : 'Publish listing', 'table-action-button');
            listingButton.type = 'button';
            listingButton.dataset.toggleListing = property.id;
            card.appendChild(listingButton);
            propertyList.appendChild(card);
        });

        const propertySelect = document.getElementById('tenant-property');
        propertySelect.replaceChildren();
        if (!properties.length) {
            const option = element('option', 'Add a property first');
            option.value = '';
            propertySelect.appendChild(option);
            document.getElementById('show-tenant-form').disabled = true;
        } else {
            properties.forEach(function (property) {
                const option = element('option', property.name);
                option.value = property.id;
                propertySelect.appendChild(option);
            });
            document.getElementById('show-tenant-form').disabled = false;
        }

        clearAndToggleEmpty(tenantList, 'tenant-list-empty', tenancies.length > 0);
        tenancies.forEach(function (tenancy) {
            const row = document.createElement('tr');
            const nameCell = cell(row, '');
            nameCell.append(element('strong', tenancy.tenant_name));
            nameCell.append(element('span', tenancy.tenant_email, 'management-email'));
            cell(row, tenancy.properties ? tenancy.properties.name : 'Unavailable property');
            cell(row, tenancy.properties ? app.currency(tenancy.properties.rent_kes) : '—');
            const statusCell = cell(row, '');
            statusCell.append(element('span', tenancy.status === 'active' ? 'Active' : 'Invitation pending',
                'status-badge ' + (tenancy.status === 'active' ? 'status-paid' : 'status-pending')));
            const actionCell = cell(row, '');
            if (tenancy.status === 'active') {
                const removeButton = element('button', 'Remove access', 'table-action-button');
                removeButton.type = 'button';
                removeButton.dataset.removeTenant = tenancy.id;
                actionCell.appendChild(removeButton);
            }
            tenantList.appendChild(row);
        });

        clearAndToggleEmpty(paymentList, 'payment-list-empty', payments.length > 0);
        payments.forEach(function (payment) {
            const row = document.createElement('tr');
            const tenant = payment.tenancies;
            cell(row, tenant ? tenant.tenant_name + ' · ' + tenant.tenant_email : 'Tenant account unavailable');
            cell(row, payment.properties ? payment.properties.name : 'Unavailable property');
            cell(row, String(payment.rent_month).slice(0, 7));
            cell(row, app.currency(payment.amount_kes));
            cell(row, payment.mpesa_reference);
            const statusCell = cell(row, '');
            const badgeText = payment.status === 'confirmed' ? 'Confirmed' :
                payment.status === 'rejected' ? 'Rejected' : 'Needs review';
            statusCell.appendChild(element('span', badgeText, 'status-badge ' +
                (payment.status === 'confirmed' ? 'status-paid' :
                    payment.status === 'rejected' ? 'status-overdue' : 'status-pending')));
            const actionCell = cell(row, '');
            if (payment.status === 'pending') {
                ['confirmed', 'rejected'].forEach(function (decision) {
                    const button = element('button',
                        decision === 'confirmed' ? 'Confirm' : 'Reject',
                        'table-action-button');
                    button.type = 'button';
                    button.dataset.reviewPayment = payment.id;
                    button.dataset.decision = decision;
                    actionCell.appendChild(button);
                });
            }
            paymentList.appendChild(row);
        });

        const noticeList = document.getElementById('landlord-notices');
        clearAndToggleEmpty(noticeList, 'landlord-notices-empty', notices.length > 0);
        notices.forEach(function (notice) {
            const item = element('li');
            item.append(element('strong', notice.subject));
            item.append(element('p', notice.message));
            item.append(element('time', app.dateTime(notice.created_at)));
            if (!notice.email_sent_at) item.append(element('p', 'Email delivery needs attention.', 'notification-warning'));
            noticeList.appendChild(item);
        });
    }

    if (!app.ready) {
        document.querySelectorAll('.dashboard-actions button, #show-property-form, #show-tenant-form')
            .forEach(function (button) { button.disabled = true; });
        return;
    }

    try {
        const context = await app.requireProfile('landlord');
        if (!context) return;
        profile = context.profile;
        document.getElementById('landlord-greeting').textContent = 'Welcome, ' + profile.full_name;
        await loadDashboard();
    } catch (error) {
        app.setStatus(pageMessage, error.message || 'Could not load your dashboard.', 'error');
        return;
    }

    document.getElementById('show-property-form').addEventListener('click', function () {
        propertyForm.hidden = false;
        document.getElementById('property-name').focus();
    });
    document.getElementById('show-tenant-form').addEventListener('click', function () {
        tenantForm.hidden = false;
        document.getElementById('tenant-name').focus();
    });
    document.querySelectorAll('[data-close-form]').forEach(function (button) {
        button.addEventListener('click', function () {
            const form = document.getElementById(button.dataset.closeForm);
            form.reset();
            form.hidden = true;
        });
    });

    propertyForm.addEventListener('submit', async function (event) {
        event.preventDefault();
        if (!propertyForm.reportValidity()) return;
        const button = propertyForm.querySelector('button[type="submit"]');
        button.disabled = true;
        app.setStatus(pageMessage, 'Saving property…', 'loading');
        const formData = new FormData(propertyForm);
        const optionalNumber = function (name) {
            const value = String(formData.get(name) || '').trim();
            return value ? Number(value) : null;
        };
        const property = {
            landlord_id: profile.id,
            name: String(formData.get('name')).trim(),
            public_area: String(formData.get('public_area')).trim(),
            exact_address: String(formData.get('exact_address')).trim(),
            rent_kes: Number(formData.get('rent_kes')),
            payment_type: String(formData.get('payment_type')),
            payment_number: String(formData.get('payment_number')).trim(),
            payment_account: String(formData.get('payment_account')).trim(),
            description: String(formData.get('description') || '').trim(),
            bedrooms: optionalNumber('bedrooms'),
            bathrooms: optionalNumber('bathrooms'),
            image_url: String(formData.get('image_url') || '').trim() || null,
            is_listed: document.getElementById('property-listed').checked
        };
        try {
            const { error } = await app.client.from('properties').insert(property);
            if (error) throw error;
            propertyForm.reset();
            propertyForm.hidden = true;
            app.setStatus(pageMessage, 'Property saved.', 'success');
            await loadDashboard();
        } catch (error) {
            app.setStatus(pageMessage, error.message || 'Property could not be saved.', 'error');
        } finally {
            button.disabled = false;
        }
    });

    tenantForm.addEventListener('submit', async function (event) {
        event.preventDefault();
        if (!tenantForm.reportValidity()) return;
        const button = tenantForm.querySelector('button[type="submit"]');
        button.disabled = true;
        app.setStatus(pageMessage, 'Registering tenant and sending access email…', 'loading');
        const formData = new FormData(tenantForm);
        try {
            await app.invoke('register_tenant', {
                name: String(formData.get('name')).trim(),
                email: String(formData.get('email')).trim().toLowerCase(),
                propertyId: String(formData.get('propertyId'))
            });
            tenantForm.reset();
            tenantForm.hidden = true;
            app.setStatus(pageMessage, 'Tenant registered. An access email has been sent.', 'success');
            await loadDashboard();
        } catch (error) {
            app.setStatus(pageMessage, error.message || 'Tenant registration could not be completed.', 'error');
            await loadDashboard();
        } finally {
            button.disabled = false;
        }
    });

    document.addEventListener('click', async function (event) {
        const removeButton = event.target.closest('[data-remove-tenant]');
        const paymentButton = event.target.closest('[data-review-payment]');
        const listingButton = event.target.closest('[data-toggle-listing]');
        if (!removeButton && !paymentButton && !listingButton) return;

        const button = removeButton || paymentButton || listingButton;
        button.disabled = true;
        try {
            if (removeButton) {
                if (!window.confirm('Remove this tenant’s access? They will receive an email notification.')) return;
                await app.invoke('remove_tenant', { tenancyId: removeButton.dataset.removeTenant });
                app.setStatus(pageMessage, 'Tenant access removed and notification email sent.', 'success');
            } else if (paymentButton) {
                const decision = paymentButton.dataset.decision;
                if (!window.confirm(decision === 'confirmed'
                    ? 'Confirm only after you have matched this receipt to your M-Pesa statement.'
                    : 'Reject this payment reference and notify the tenant?')) return;
                await app.invoke('review_payment', {
                    paymentId: paymentButton.dataset.reviewPayment,
                    decision: decision
                });
                app.setStatus(pageMessage,
                    decision === 'confirmed' ? 'Payment confirmed and tenant notified.' : 'Reference rejected and tenant notified.',
                    'success');
            } else {
                const property = properties.find(function (item) {
                    return item.id === listingButton.dataset.toggleListing;
                });
                if (!property) throw new Error('This property is no longer available.');
                const { error } = await app.client.from('properties')
                    .update({ is_listed: !property.is_listed })
                    .eq('id', property.id);
                if (error) throw error;
                app.setStatus(pageMessage,
                    property.is_listed ? 'Listing unpublished.' : 'Listing published.',
                    'success');
            }
            await loadDashboard();
        } catch (error) {
            app.setStatus(pageMessage, error.message || 'The requested action could not be completed.', 'error');
            await loadDashboard();
        } finally {
            button.disabled = false;
        }
    });

    document.getElementById('sign-out').addEventListener('click', async function () {
        const { error } = await app.client.auth.signOut();
        if (error) {
            app.setStatus(pageMessage, error.message || 'Could not log out.', 'error');
            return;
        }
        window.location.replace('login.html');
    });
});
