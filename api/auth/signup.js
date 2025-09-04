// /api/auth/signup.js
import { supabaseAdmin } from '../_db.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const { email, password } = req.body;
        if (!email || !password || password.length < 6) {
            return res.status(400).json({ error: 'Email and a password of at least 6 characters are required.' });
        }

        // Use the admin client to create the user.
        // The `handle_new_user` trigger will still fire correctly to create the profile.
        const { data, error } = await supabaseAdmin.auth.createUser({
            email: email,
            password: password,
            // You can add email_confirm: true here if you want to enforce email verification
        });

        if (error) {
            console.error(`Signup failed for ${email}:`, error.message);
            return res.status(400).json({ error: error.message });
        }

        // Return the new user object on success.
        return res.status(201).json(data);

    } catch (e) {
        console.error("Critical error in /api/auth/signup:", e);
        return res.status(500).json({ error: 'An internal server error occurred.' });
    }
}