// api/user/profile.js - VERBOSE DEBUGGING
import { getUserFromRequest } from '../_db.js';

export default async function handler(req, res) {
    console.log("--- [API /api/user/profile] Handler started ---");
    console.log(`[API /api/user/profile] Request Method: ${req.method}`);

    if (req.method !== 'GET') {
        res.setHeader('Allow', ['GET']);
        return res.status(405).end('Method Not Allowed');
    }

    console.log("[API /api/user/profile] Calling getUserFromRequest helper...");
    const { user, profile, error } = await getUserFromRequest(req);
    console.log("[API /api/user/profile] Returned from getUserFromRequest helper.");
    console.log("[API /api/user/profile] Helper Result - User:", user ? { id: user.id, email: user.email } : null);
    console.log("[API /api/user/profile] Helper Result - Profile:", profile);
    console.log("[API /api/user/profile] Helper Result - Error:", error);

    if (error || !user) {
        console.error("[API /api/user/profile] Authorization failed. Sending 401 response.");
        return res.status(401).json({ error: error?.message || 'Unauthorized' });
    }

    if (!profile) {
        console.warn("[API /api/user/profile] User is authenticated, but no profile found. Sending 404 response.");
        return res.status(404).json({ error: 'Profile not found for this user.' });
    }

    console.log("[API /api/user/profile] Successfully found profile. Sending 200 OK response.");
    res.status(200).json(profile);
}