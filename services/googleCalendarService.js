/*
Google Cloud Console setup:
1. Go to https://console.cloud.google.com and create a new project.
2. Enable the Google Calendar API for that project.
3. Open Credentials and create an OAuth 2.0 Client ID.
4. Set application type to Web application.
5. Add http://localhost:3001/api/integrations/google/callback as an authorized redirect URI.
6. Copy client ID and client secret into your server .env file.
*/

const { google } = require('googleapis');
const User = require('../database/models/User');

const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

function buildOAuthClient() {
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
        throw new Error('Google OAuth env vars are missing');
    }

    const OAuth2 = google.auth.OAuth2;
    return new OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}

function getAuthUrl(state) {
    const oauth2Client = buildOAuthClient();
    return oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: [CALENDAR_SCOPE],
        state,
    });
}

async function exchangeCodeForTokens(code) {
    if (!code) throw new Error('Missing OAuth code');

    const oauth2Client = buildOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);

    return {
        access_token: tokens.access_token || '',
        refresh_token: tokens.refresh_token || '',
        expiry_date: tokens.expiry_date || null,
    };
}

function getAuthenticatedClient(user) {
    const oauth2Client = buildOAuthClient();
    const googleCalendar = user?.googleCalendar || {};

    oauth2Client.setCredentials({
        refresh_token: googleCalendar.refreshToken || undefined,
        access_token: googleCalendar.accessToken || undefined,
        expiry_date: googleCalendar.tokenExpiry ? new Date(googleCalendar.tokenExpiry).getTime() : undefined,
    });

    return oauth2Client;
}

function getDateInKolkata(daysAhead) {
    const now = new Date();
    const kolkataNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    kolkataNow.setDate(kolkataNow.getDate() + daysAhead);

    const year = kolkataNow.getFullYear();
    const month = String(kolkataNow.getMonth() + 1).padStart(2, '0');
    const day = String(kolkataNow.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function cleanTodoSummary(todoText) {
    return String(todoText || '')
        // Remove common checkbox markers and bullets.
        .replace(/[✅☑✔▣]/g, ' ')
        // Remove leading numbering such as "1." or "2)".
        .replace(/^\s*\d+\s*[.)-]?\s*/i, '')
        // Remove inline priority/time metadata.
        .replace(/\s*[-|,;]?\s*Priority\s*:\s*[^|,;\-]+/ig, '')
        .replace(/\s*[-|,;]?\s*Est\s*:\s*[^|,;\-]+/ig, '')
        // Collapse duplicate spaces.
        .replace(/\s{2,}/g, ' ')
        .trim();
}

async function createCalendarEvent(userId, todoItems) {
    if (!userId) throw new Error('Missing userId');
    if (!Array.isArray(todoItems) || todoItems.length === 0) {
        throw new Error('todos must be a non-empty array');
    }

    const user = await User.findById(userId);
    if (!user) throw new Error('User not found');
    if (!user.googleCalendar?.connected) throw new Error('Google Calendar not connected');

    const auth = getAuthenticatedClient(user);
    const calendar = google.calendar({ version: 'v3', auth });

    const createdEventLinks = [];

    for (const [index, rawTodo] of todoItems.entries()) {
        const todoText = String(rawTodo || '').trim();
        if (!todoText) continue;

        const tasksPerDay = 4;
        const baseHour = 9;
        const dayOffset = Math.floor(index / tasksPerDay) + 1; // +1 = tomorrow
        const hourOffset = index % tasksPerDay;
        const startHour = baseHour + hourOffset;
        const endHour = startHour + 1;
        const dateStr = getDateInKolkata(dayOffset);

        const cleanSummary = cleanTodoSummary(todoText);

        const event = {
            summary: cleanSummary || todoText,
            description: todoText,
            start: {
                dateTime: `${dateStr}T${String(startHour).padStart(2, '0')}:00:00`,
                timeZone: 'Asia/Kolkata',
            },
            end: {
                dateTime: `${dateStr}T${String(endHour).padStart(2, '0')}:00:00`,
                timeZone: 'Asia/Kolkata',
            },
        };

        const inserted = await calendar.events.insert({
            calendarId: 'primary',
            requestBody: event,
        });

        createdEventLinks.push(inserted.data.htmlLink || inserted.data.id);
    }

    return createdEventLinks;
}

module.exports = {
    getAuthUrl,
    exchangeCodeForTokens,
    getAuthenticatedClient,
    createCalendarEvent,
};
