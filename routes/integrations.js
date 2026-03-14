const express = require('express');
const crypto = require('crypto');
const { google } = require('googleapis');
const { requireAuth } = require('../middleware/auth');
const User = require('../database/models/User');
const {
    getAuthUrl,
    exchangeCodeForTokens,
    createCalendarEvent,
    getAuthenticatedClient,
} = require('../services/googleCalendarService');

const router = express.Router();
const oauthStateMap = new Map();

router.get('/google/auth', requireAuth, async (req, res) => {
    try {
        const state = crypto.randomUUID();
        oauthStateMap.set(state, req.user.userId);

        // Expire state after 10 minutes to prevent unbounded growth.
        setTimeout(() => oauthStateMap.delete(state), 10 * 60 * 1000);

        const url = getAuthUrl(state);
        res.json({ url });
    } catch (error) {
        res.status(500).json({ error: error.message || 'Failed to generate Google auth URL' });
    }
});

router.get('/google/callback', async (req, res) => {
    try {
        const { code, state } = req.query;
        if (!code || !state) {
            return res.status(400).send('Missing code or state');
        }

        const userId = oauthStateMap.get(state);
        oauthStateMap.delete(state);

        if (!userId) {
            return res.status(400).send('Invalid or expired OAuth state');
        }

        const tokens = await exchangeCodeForTokens(code);

        const existingUser = await User.findById(userId).lean();

        await User.findByIdAndUpdate(userId, {
            $set: {
                'googleCalendar.refreshToken': tokens.refresh_token || '',
                'googleCalendar.accessToken': tokens.access_token || '',
                'googleCalendar.tokenExpiry': tokens.expiry_date ? new Date(tokens.expiry_date) : null,
                'googleCalendar.connected': true,
                'googleCalendar.accountEmail': existingUser?.email || '',
            },
        });

        const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
        return res.redirect(`${clientUrl}/?googleConnected=true`);
    } catch (error) {
        return res.status(500).send(`Google callback failed: ${error.message}`);
    }
});

router.get('/google/status', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId).lean();
        if (!user) return res.status(404).json({ message: 'User not found' });

        res.json({
            connected: user.googleCalendar?.connected === true,
            accountEmail: user.googleCalendar?.accountEmail || '',
        });
    } catch (error) {
        res.status(500).json({ error: error.message || 'Failed to fetch Google status' });
    }
});

router.post('/google/create-events', requireAuth, async (req, res) => {
    try {
        const { todos } = req.body;
        if (!Array.isArray(todos) || todos.length === 0) {
            return res.status(400).json({ error: 'todos must be a non-empty array of strings' });
        }

        const links = await createCalendarEvent(req.user.userId, todos);
        return res.json({ links });
    } catch (error) {
        return res.status(500).json({ error: error.message || 'Failed to create events' });
    }
});

router.delete('/google/disconnect', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        if (!user.googleCalendar) user.googleCalendar = {};
        user.googleCalendar.refreshToken = '';
        user.googleCalendar.accessToken = '';
        user.googleCalendar.tokenExpiry = null;
        user.googleCalendar.connected = false;
        user.googleCalendar.accountEmail = '';

        await user.save();

        return res.json({ success: true });
    } catch (error) {
        return res.status(500).json({ error: error.message || 'Failed to disconnect Google Calendar' });
    }
});

router.get('/google/events', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId).lean();
        if (!user) return res.status(404).json({ message: 'User not found' });
        if (!user.googleCalendar?.connected) {
            return res.status(400).json({ error: 'Google Calendar not connected' });
        }

        const auth = getAuthenticatedClient(user);
        const calendar = google.calendar({ version: 'v3', auth });

        const now = new Date();
        const sevenDaysFromNow = new Date(now);
        sevenDaysFromNow.setDate(now.getDate() + 7);

        const response = await calendar.events.list({
            calendarId: 'primary',
            timeMin: now.toISOString(),
            timeMax: sevenDaysFromNow.toISOString(),
            maxResults: 20,
            singleEvents: true,
            orderBy: 'startTime',
        });

        const events = (response.data.items || []).map((evt) => ({
            id: evt.id,
            summary: evt.summary,
            description: evt.description,
            start: evt.start,
            end: evt.end,
            htmlLink: evt.htmlLink,
        }));

        return res.json({ events });
    } catch (error) {
        return res.status(500).json({ error: error.message || 'Failed to fetch calendar events' });
    }
});

module.exports = router;
