const express = require('express');
const { requireAuth } = require('../middleware/auth');
const User = require('../database/models/User');
const transporter = require('../services/mailer');

const router = express.Router();
router.use(requireAuth);

router.post('/test', async (req, res) => {
    try {
        const { channel, emailAddress } = req.body;
        console.log('[Notifications Test] userId:', req.user.userId, 'channel:', channel, 'emailAddress:', emailAddress || '(none)');
        const user = await User.findById(req.user.userId).lean();
        if (!user) return res.status(404).json({ message: 'User not found' });

        if (!Boolean(user?.notifications?.emailEnabled)) {
            console.log('Email skipped — user has notifications disabled');
            return res.json({ sent: false, skipped: true, reason: 'notifications_disabled' });
        }

        if (channel !== 'email') {
            return res.status(400).json({ message: 'Unsupported channel' });
        }

        const typed = String(emailAddress || '').trim();
        const to = typed || user.notifications?.emailAddress || user.email;
        if (!to) return res.status(400).json({ message: 'No default email address configured.' });

        await transporter.sendMail({
            from: process.env.SMTP_USER,
            to,
            subject: 'AgentForge Test Notification',
            html: '<p>Your AgentForge notifications are working correctly.</p>',
        });

        return res.json({ sent: true, channel: 'email', to });
    } catch (error) {
        return res.status(500).json({ message: error.message || 'Failed to send test notification' });
    }
});

module.exports = router;
