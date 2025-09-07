// /api/auth/signup.js
import { supabaseAdmin } from '../_db.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const { email, password } = req.body;

        // Basic server-side validation
        if (!email || !password || password.length < 6) {
            return res.status(400).json({ error: 'Email and a password of at least 6 characters are required.' });
        }

        console.log(`[API /auth/signup] Attempting to create user for: ${email}`);

        // --- THE FIX ---
        // The correct function is supabaseAdmin.auth.admin.createUser
        const { data, error } = await supabaseAdmin.auth.admin.createUser({
            email: email,
            password: password,
            // By default, Supabase sends a confirmation email.
            // You can override this if you want to confirm them automatically from the backend.
            // For now, we will let it send the email, but your "Autoconfirm" setting in the UI
            // will mark them as confirmed anyway.
            email_confirm: false, // Let the autoconfirm setting in the dashboard handle it.
        });
        // --- END FIX ---

        if (error) {
            // Log the detailed error on the server
            console.error(`[API /auth/signup] Supabase signup error for ${email}:`, error.message);
            // Return a user-friendly error to the client
            return res.status(400).json({ error: error.message });
        }

        console.log(`[API /auth/signup] User created successfully for: ${email}`);
        // The `handle_new_user` trigger will automatically create the profile.
        // Return the new user object on success.
        return res.status(201).json(data);

    } catch (e) {
        console.error("Critical error in /api/auth/signup:", e);
        return res.status(500).json({ error: 'An internal server error occurred.' });
    }
}