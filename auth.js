document.addEventListener('DOMContentLoaded', function () {
    const app = window.RentMaster;
    const signupForm = document.getElementById('signup-form');
    const loginForm = document.getElementById('login-form');
    const requestResetForm = document.getElementById('request-reset-form');
    const updatePasswordForm = document.getElementById('update-password-form');

    if (signupForm) {
        const role = new URLSearchParams(window.location.search).get('role');
        if (role === 'landlord' || role === 'tenant') {
            document.getElementById('signup-role').value = role;
        }
        const email = new URLSearchParams(window.location.search).get('email');
        if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            document.getElementById('signup-email').value = email;
        }
    }

    if (!app.ready) {
        document.querySelectorAll('form button[type="submit"]').forEach(function (button) {
            button.disabled = true;
        });
        const status = document.getElementById('auth-status');
        if (status) app.setStatus(status, app.getConfigurationMessage(), 'error');
        return;
    }

    if (requestResetForm && updatePasswordForm) {
        const message = document.getElementById('reset-message');
        app.client.auth.getSession().then(function (result) {
            if (result.error) {
                app.setStatus(message, result.error.message, 'error');
                return;
            }
            if (result.data.session) {
                requestResetForm.hidden = true;
                updatePasswordForm.hidden = false;
            }
        });

        requestResetForm.addEventListener('submit', async function (event) {
            event.preventDefault();
            if (!requestResetForm.reportValidity()) return;
            const button = document.getElementById('reset-submit');
            button.disabled = true;
            try {
                const { error } = await app.client.auth.resetPasswordForEmail(
                    document.getElementById('reset-email').value.trim().toLowerCase(),
                    { redirectTo: new URL('reset-password.html', window.location.href).href }
                );
                if (error) throw error;
                app.setStatus(
                    message,
                    'If an account exists for that address, a password reset link will arrive shortly.',
                    'success'
                );
            } catch (error) {
                app.setStatus(message, error.message || 'The reset email could not be sent.', 'error');
            } finally {
                button.disabled = false;
            }
        });

        updatePasswordForm.addEventListener('submit', async function (event) {
            event.preventDefault();
            if (!updatePasswordForm.reportValidity()) return;
            const button = document.getElementById('update-password-submit');
            button.disabled = true;
            try {
                const { error } = await app.client.auth.updateUser({
                    password: document.getElementById('new-password').value
                });
                if (error) throw error;
                await app.client.auth.signOut();
                window.location.replace('login.html?password=updated');
            } catch (error) {
                app.setStatus(message, error.message || 'Your password could not be updated.', 'error');
            } finally {
                button.disabled = false;
            }
        });
    }

    if (signupForm) {
        signupForm.addEventListener('submit', async function (event) {
            event.preventDefault();
            const button = document.getElementById('signup-submit');
            const message = document.getElementById('signup-message');
            if (!signupForm.reportValidity()) return;
            button.disabled = true;
            app.setStatus(message, 'Creating your account…', 'loading');
            const emailValue = document.getElementById('signup-email').value.trim().toLowerCase();
            const fullName = document.getElementById('fullname').value.trim();
            const roleValue = document.getElementById('signup-role').value;
            try {
                const { data, error } = await app.client.auth.signUp({
                    email: emailValue,
                    password: document.getElementById('signup-password').value,
                    options: {
                        data: { full_name: fullName, role: roleValue },
                        emailRedirectTo: new URL('login.html', window.location.href).href
                    }
                });
                if (error) throw error;
                if (data.session) {
                    if (!data.user.email_confirmed_at) {
                        await app.client.auth.signOut();
                        app.setStatus(
                            message,
                            'Account created. Check your email to verify your address, then log in to continue.',
                            'success'
                        );
                        signupForm.reset();
                        if (roleValue === 'landlord' || roleValue === 'tenant') {
                            document.getElementById('signup-role').value = roleValue;
                        }
                        return;
                    }
                    const { data: profile, error: profileError } = await app.client
                        .from('profiles')
                        .select('role')
                        .eq('id', data.user.id)
                        .single();
                    if (profileError) throw profileError;
                    window.location.replace(app.dashboardPath(profile.role));
                    return;
                }
                app.setStatus(
                    message,
                    'Account created. Check your email to verify your address, then log in to continue.',
                    'success'
                );
                signupForm.reset();
                if (roleValue === 'landlord' || roleValue === 'tenant') {
                    document.getElementById('signup-role').value = roleValue;
                }
            } catch (error) {
                app.setStatus(message, error.message || 'We could not create your account. Please try again.', 'error');
            } finally {
                button.disabled = false;
            }
        });
    }

    if (loginForm) {
        const authStatus = new URLSearchParams(window.location.search).get('error_description');
        if (authStatus) {
            app.setStatus(document.getElementById('login-message'), authStatus, 'error');
        } else if (new URLSearchParams(window.location.search).get('verification') === 'required') {
            app.setStatus(
                document.getElementById('login-message'),
                'Verify your email address before accessing your account.',
                'error'
            );
        } else if (new URLSearchParams(window.location.search).get('password') === 'updated') {
            app.setStatus(document.getElementById('login-message'), 'Password updated. Sign in with your new password.', 'success');
        }
        loginForm.addEventListener('submit', async function (event) {
            event.preventDefault();
            const button = document.getElementById('login-submit');
            const message = document.getElementById('login-message');
            if (!loginForm.reportValidity()) return;
            button.disabled = true;
            app.setStatus(message, 'Signing you in…', 'loading');
            try {
                const { data, error } = await app.client.auth.signInWithPassword({
                    email: document.getElementById('email').value.trim().toLowerCase(),
                    password: document.getElementById('password').value
                });
                if (error) throw error;
                if (!data.user.email_confirmed_at) {
                    await app.client.auth.signOut();
                    throw new Error('Verify your email address before logging in.');
                }
                const { data: profile, error: profileError } = await app.client
                    .from('profiles')
                    .select('role')
                    .eq('id', data.user.id)
                    .single();
                if (profileError) throw profileError;
                window.location.replace(app.dashboardPath(profile.role));
            } catch (error) {
                app.setStatus(message, error.message || 'We could not sign you in. Check your details and try again.', 'error');
            } finally {
                button.disabled = false;
            }
        });
    }
});
