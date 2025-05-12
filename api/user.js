// api/user.js
import { getUserFromRequest, getUserProfile as fetchUserProfile, getSupabaseAdminClient } from './_db.js';

export default async function handler(req, res) {
    const user = await getUserFromRequest(req);
    if (!user) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    const supabaseAdmin = getSupabaseAdminClient(); // We use Supabase for profiles always in this example
    if (!supabaseAdmin) {
        return res.status(500).json({ message: 'User profile system not configured.' });
    }

    if (req.method === 'GET' && req.url.endsWith('/profile')) { // e.g. /api/user/profile
        try {
            const profile = await fetchUserProfile(user.id); // Use the shared function
            if (!profile) {
                 // This can happen if a user exists in auth.users but not profiles table
                 // Potentially create a default 'customer' profile here on-demand if desired, or just 404.
                 // For now, 404 indicates no specific profile/role data beyond auth.
                return res.status(404).json({ message: 'Profile not found.'});
            }
            return res.status(200).json(profile);
        } catch (error) {
            console.error('Error fetching user profile:', error);
            return res.status(500).json({ message: 'Failed to fetch profile', error: error.message });
        }
    } else if (req.method === 'PUT' && req.url.endsWith('/profile')) {
        // Update user profile (e.g., full_name, but NOT role - role changes are sensitive)
        try {
            const { full_name } = req.body; // Only allow specific fields to be updated by user
            if (full_name === undefined ) { // Check if full_name key exists, even if empty string
                 return res.status(400).json({ message: 'No valid fields to update provided.' });
            }

            const { data, error } = await supabaseAdmin
                .from('profiles')
                .update({ full_name })
                .eq('id', user.id)
                .select()
                .single();
            
            if (error) throw error;
            if (!data) return res.status(404).json({ message: "Profile not found to update."});
            return res.status(200).json(data);
        } catch (error) {
            console.error('Error updating user profile:', error);
            return res.status(500).json({ message: 'Failed to update profile', error: error.message });
        }
    }
    // TODO: Add endpoint for Manager to update user roles (highly sensitive)
    // e.g., POST /api/user/:userId/role { newRole: 'owner' }
    // This would need strong checks that the calling user is a 'manager'.

    else {
        res.setHeader('Allow', ['GET', 'PUT']);
        res.status(405).end(`Method ${req.method} Not Allowed`);
    }
}