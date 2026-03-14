const express = require('express');
const PermissionRequest = require('../database/models/PermissionRequest');
const transporter = require('../services/mailer');
const User = require('../database/models/User');

const router = express.Router();

function htmlPage(title, body) {
    return `<!doctype html><html><head><meta charset="utf-8"/><title>${title}</title></head><body style="font-family:sans-serif;padding:30px;max-width:700px;margin:0 auto;"><h2>${title}</h2><p>${body}</p></body></html>`;
}

router.get('/accept', async (req, res) => {
    try {
        const { token } = req.query;
        if (!token) return res.status(400).send(htmlPage('Invalid request', 'Missing token.'));

        const request = await PermissionRequest.findOne({ token });
        if (!request) return res.status(404).send(htmlPage('Request not found', 'This permission request could not be found.'));

        if (request.status !== 'pending') {
            return res.status(400).send(htmlPage('Already processed', 'This permission request has already been processed.'));
        }

        if (new Date(request.expiresAt) < new Date()) {
            request.status = 'expired';
            await request.save();
            return res.status(400).send(htmlPage('Request expired', 'This permission request has expired.'));
        }

        request.status = 'accepted';
        await request.save();

        const sender = request.fromUserId ? await User.findById(request.fromUserId).lean() : null;
        if (sender && sender.notifications?.emailEnabled === false) {
            console.log('Email skipped — user has notifications disabled');
            return res.send(htmlPage(
                'Permission accepted',
                'Permission was accepted, but the sender currently has notifications disabled, so no email was sent.'
            ));
        }

        await transporter.sendMail({
            from: process.env.SMTP_USER,
            to: request.toEmail,
            subject: request.pendingSubject || 'AgentForge Pipeline Results',
            html: request.pendingEmailContent || '',
        });

        return res.send(htmlPage(
            'Permission accepted',
            `You have accepted the email from ${request.fromUserName || 'the sender'}. The email has been delivered. You can close this tab.`
        ));
    } catch (error) {
        return res.status(500).send(htmlPage('Error', `Failed to process request: ${error.message}`));
    }
});

router.get('/decline', async (req, res) => {
    try {
        const { token } = req.query;
        if (!token) return res.status(400).send(htmlPage('Invalid request', 'Missing token.'));

        const request = await PermissionRequest.findOne({ token });
        if (!request) return res.status(404).send(htmlPage('Request not found', 'This permission request could not be found.'));

        if (request.status === 'pending') {
            request.status = 'declined';
            await request.save();
        }

        return res.send(htmlPage(
            'Permission declined',
            `You have declined the email from ${request.fromUserName || 'the sender'}. No emails will be sent to you from this source.`
        ));
    } catch (error) {
        return res.status(500).send(htmlPage('Error', `Failed to process request: ${error.message}`));
    }
});

module.exports = router;
