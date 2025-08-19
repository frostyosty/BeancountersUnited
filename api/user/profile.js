// api/user/profile.js
import { getUserFromRequest } from '../_db.js';

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        res.setHeader('Allow', ['GET']);
        return res.status(405).end('Method Not Allowed');
    }

    const { user, profile, error } = await getUserFromRequest(req);

    if (error || !user) {
        return res.status(401).json({ error: error?.message || 'Unauthorized' });
    }

    // The profile was already fetched by the helper function.
    if (!profile) {
        return res.status(404).json({ error: 'Profile not found for this user.' });
    }

    // Return the profile data (contains the role)
    res.status(200).json(profile);
}