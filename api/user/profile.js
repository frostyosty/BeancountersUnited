// api/user/profile.js
import { getUserFromRequest } from '../_db.js';

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        res.setHeader('Allow', ['GET']);
        return res.status(405).end('Method Not Allowed');
    }

    try {
        const { user, profile, error: authError } = await getUserFromRequest(req);

        if (authError || !user) {
            // This is a client error (bad token), so 401 Unauthorized
            console.warn("Unauthorized attempt to get profile:", authError?.message);
            return res.status(401).json({ error: authError?.message || 'Unauthorized' });
        }

        if (!profile) {
            // The user is real, but they don't have a profile row. This is a 404 Not Found.
            console.warn(`User ${user.id} is authenticated but has no profile.`);
            return res.status(404).json({ error: 'Profile not found for this user.' });
        }

        // Success! Return the profile data.
        return res.status(200).json(profile);

    } catch (e) {
        // This catches unexpected server errors
        console.error("CRITICAL ERROR in /api/user/profile:", e);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
}