document.addEventListener('DOMContentLoaded', async function () {
    const app = window.RentMaster;
    const container = document.getElementById('featured-listings') ||
        document.getElementById('rental-listings');
    if (!container) return;
    const status = document.getElementById('listing-status');
    const searchInput = document.getElementById('listing-search');
    const rentInput = document.getElementById('maximum-rent');
    const bedroomInput = document.getElementById('minimum-bedrooms');
    const count = document.getElementById('listing-count');
    const isFeatured = container.id === 'featured-listings';

    if (!app.ready) {
        container.replaceChildren();
        const message = document.createElement('p');
        message.className = 'empty-state';
        message.dataset.requiresBackend = '';
        message.textContent = app.getConfigurationMessage();
        container.appendChild(message);
        return;
    }

    try {
        const { data, error } = await app.client
            .from('public_property_listings')
            .select('id, name, public_area, rent_kes, description, bedrooms, bathrooms, image_url, created_at')
            .order('created_at', { ascending: false })
            .limit(isFeatured ? 3 : 100);
        if (error) throw error;
        const listings = data || [];

        function render() {
            const query = searchInput ? searchInput.value.trim().toLowerCase() : '';
            const maximumRent = rentInput && rentInput.value ? Number(rentInput.value) : null;
            const minimumBedrooms = bedroomInput && bedroomInput.value ? Number(bedroomInput.value) : null;
            const filtered = listings.filter(function (listing) {
                const text = [listing.name, listing.public_area, listing.description]
                    .filter(Boolean).join(' ').toLowerCase();
                return (!query || text.includes(query)) &&
                    (maximumRent === null || listing.rent_kes <= maximumRent) &&
                    (minimumBedrooms === null || Number(listing.bedrooms || 0) >= minimumBedrooms);
            });

            container.replaceChildren();
            if (count) count.textContent = filtered.length + (filtered.length === 1 ? ' home' : ' homes');
            if (!filtered.length) {
                const empty = document.createElement('p');
                empty.className = 'empty-state';
                empty.textContent = listings.length
                    ? 'No homes match those filters. Try a wider search.'
                    : 'No homes are listed yet. Check back soon or create an account to register your property.';
                container.appendChild(empty);
                return;
            }
            filtered.forEach(function (listing) {
                container.insertAdjacentHTML('beforeend', app.propertyCard(listing, { listing: !isFeatured }));
            });
        }

        render();
        [searchInput, rentInput, bedroomInput].filter(Boolean).forEach(function (input) {
            input.addEventListener('input', render);
        });
    } catch (error) {
        container.replaceChildren();
        const message = document.createElement('p');
        message.className = 'empty-state';
        message.textContent = error.message || 'Available homes could not be loaded. Please try again later.';
        container.appendChild(message);
        if (status) app.setStatus(status, message.textContent, 'error');
    }
});
