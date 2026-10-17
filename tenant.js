document.addEventListener('DOMContentLoaded', async function () {
    const app = window.RentMaster;
    const status = document.getElementById('tenant-message');
    const form = document.getElementById('payment-form');
    let properties = [];

    function element(tag, text, className) {
        const node = document.createElement(tag);
        if (text !== undefined && text !== null) node.textContent = text;
        if (className) node.className = className;
        return node;
    }

    async function loadDashboard() {
        const [rentalResult, paymentResult, noticeResult] = await Promise.all([
            app.client.rpc('get_my_rental_properties'),
            app.client.from('rent_payments')
                .select('id, property_id, rent_month, amount_kes, mpesa_reference, status, created_at')
                .order('rent_month', { ascending: false }),
            app.client.from('notifications')
                .select('id, subject, message, created_at')
                .order('created_at', { ascending: false })
                .limit(30)
        ]);
        const failure = [rentalResult, paymentResult, noticeResult].find(function (result) {
            return result.error;
        });
        if (failure) throw failure.error;

        properties = rentalResult.data || [];
        const payments = paymentResult.data || [];
        const notices = noticeResult.data || [];
        const month = app.currentMonth();
        const confirmedTotal = payments.filter(function (payment) {
            return payment.status === 'confirmed' && String(payment.rent_month).slice(0, 7) === month;
        }).reduce(function (total, payment) {
            return total + Number(payment.amount_kes);
        }, 0);

        document.getElementById('rental-count').textContent = String(properties.length);
        document.getElementById('pending-count').textContent = String(payments.filter(function (payment) {
            return payment.status === 'pending';
        }).length);
        document.getElementById('confirmed-total').textContent = app.currency(confirmedTotal);
        document.getElementById('no-tenancy-message').hidden = properties.length > 0;
        document.getElementById('payment-submit-panel').hidden = properties.length === 0;

        const propertyContainer = document.getElementById('tenant-properties');
        propertyContainer.replaceChildren();
        const propertyById = new Map();
        const propertySelect = document.getElementById('payment-property');
        propertySelect.replaceChildren();
        properties.forEach(function (property) {
            propertyById.set(property.property_id, property);
            const card = element('article', null, 'management-property-card');
            card.append(element('h3', property.property_name));
            card.append(element('p', property.public_area, 'tenant-meta'));
            card.append(element('p', property.exact_address, 'management-property-payment'));
            card.append(element('p', app.currency(property.rent_kes) + ' / month', 'management-property-rent'));
            card.append(element('p', property.payment_type + ': ' + property.payment_number +
                ' · Account / business name: ' + property.payment_account, 'management-property-payment'));
            propertyContainer.appendChild(card);
            const option = element('option', property.property_name);
            option.value = property.property_id;
            propertySelect.appendChild(option);
        });

        const history = document.getElementById('payment-history');
        history.replaceChildren();
        document.getElementById('payment-history-empty').hidden = payments.length > 0;
        payments.forEach(function (payment) {
            const row = document.createElement('tr');
            const property = propertyById.get(payment.property_id);
            [
                property ? property.property_name : 'Former rental',
                String(payment.rent_month).slice(0, 7),
                app.currency(payment.amount_kes),
                payment.mpesa_reference,
                app.dateTime(payment.created_at)
            ].forEach(function (value) {
                const cell = element('td', value);
                row.appendChild(cell);
            });
            const statusCell = document.createElement('td');
            const label = payment.status === 'confirmed' ? 'Confirmed' :
                payment.status === 'rejected' ? 'Needs attention' : 'Awaiting review';
            statusCell.appendChild(element('span', label, 'status-badge ' +
                (payment.status === 'confirmed' ? 'status-paid' :
                    payment.status === 'rejected' ? 'status-overdue' : 'status-pending')));
            row.appendChild(statusCell);
            history.appendChild(row);
        });

        const noticeList = document.getElementById('tenant-notices');
        noticeList.replaceChildren();
        document.getElementById('notice-list-empty').hidden = notices.length > 0;
        notices.forEach(function (notice) {
            const item = element('li');
            item.append(element('strong', notice.subject));
            item.append(element('p', notice.message));
            item.append(element('time', app.dateTime(notice.created_at)));
            noticeList.appendChild(item);
        });
    }

    if (!app.ready) {
        document.getElementById('payment-submit').disabled = true;
        return;
    }

    try {
        const context = await app.requireProfile('tenant');
        if (!context) return;
        document.getElementById('welcome-heading').textContent = 'Welcome, ' + context.profile.full_name;
        await loadDashboard();
    } catch (error) {
        app.setStatus(status, error.message || 'Could not load your rental details.', 'error');
        return;
    }

    document.getElementById('payment-month').value = app.currentMonth();
    form.addEventListener('submit', async function (event) {
        event.preventDefault();
        if (!form.reportValidity()) return;
        const button = document.getElementById('payment-submit');
        button.disabled = true;
        app.setStatus(status, 'Submitting your reference…', 'loading');
        try {
            await app.invoke('submit_payment', {
                propertyId: document.getElementById('payment-property').value,
                rentMonth: document.getElementById('payment-month').value,
                reference: document.getElementById('payment-reference').value.trim().toUpperCase()
            });
            form.reset();
            document.getElementById('payment-month').value = app.currentMonth();
            app.setStatus(status, 'Reference submitted. Your landlord has been notified; payment remains pending until reviewed.', 'success');
            await loadDashboard();
        } catch (error) {
            app.setStatus(status, error.message || 'The reference could not be submitted.', 'error');
            await loadDashboard();
        } finally {
            button.disabled = false;
        }
    });

    document.getElementById('sign-out').addEventListener('click', async function () {
        const { error } = await app.client.auth.signOut();
        if (error) {
            app.setStatus(status, error.message || 'Could not log out.', 'error');
            return;
        }
        window.location.replace('login.html');
    });
});
