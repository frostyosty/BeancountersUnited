// api/create-payment-intent.js
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const { amount } = req.body;

        // Validation
        if (!amount || isNaN(amount) || amount <= 0) {
            return res.status(400).json({ error: "Invalid amount" });
        }

        // Create PaymentIntent
        // Amount must be an integer in cents (e.g. $4.50 => 450)
        // We assume the frontend sends dollars/float, so we convert.
        // If frontend sends cents, remove the * 100.
        // Standard practice in this app seems to be dollars based on previous context.
        const amountInCents = Math.round(parseFloat(amount) * 100);

        // Enforce minimum stripe amount (~$0.50 USD equivalent)
        if (amountInCents < 50) {
            return res.status(400).json({ error: "Amount too small for card payment." });
        }

        const paymentIntent = await stripe.paymentIntents.create({
            amount: amountInCents,
            currency: 'usd', // Change to 'nzd', 'aud', etc as needed
            automatic_payment_methods: {
                enabled: true,
            },
        });

        return res.status(200).json({
            clientSecret: paymentIntent.client_secret,
        });

    } catch (error) {
        console.error("Stripe Error:", error);
        return res.status(500).json({ error: error.message });
    }
}