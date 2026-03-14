const { v4: uuidv4 } = require('uuid');
const PermissionRequest = require('../database/models/PermissionRequest');
const transporter = require('./mailer');

async function createPermissionRequest({ user, toEmail, subject, htmlBody }) {
    if (!Boolean(user?.notifications?.emailEnabled)) {
        console.log('Email skipped — user has notifications disabled');
        return null;
    }

    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const request = await PermissionRequest.create({
        token,
        fromUserId: String(user._id || user.id || ''),
        fromUserName: user.name || 'Someone',
        fromUserEmail: user.email || '',
        toEmail,
        pendingEmailContent: htmlBody,
        pendingSubject: subject || 'AgentForge Pipeline Results',
        expiresAt,
        status: 'pending',
    });

    const baseUrl = process.env.SERVER_URL || `http://localhost:${process.env.PORT || 3001}`;
    const acceptUrl = `${baseUrl}/api/permissions/accept?token=${encodeURIComponent(token)}`;
    const declineUrl = `${baseUrl}/api/permissions/decline?token=${encodeURIComponent(token)}`;

    const preview = String(htmlBody || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);

    const html = `
        <div style="font-family:sans-serif;max-width:680px;margin:0 auto;color:#1f2937;line-height:1.6;">
            <h2 style="margin-bottom:8px;color:#111827;">Action required: ${user.name || 'A sender'} wants to send you a message via AgentForge</h2>
            <p>${user.name || 'The sender'} is using AgentForge, an AI agent platform, and wants to send you the following email.</p>
            <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px;margin:16px 0;">
                <p style="margin:0;font-size:14px;color:#374151;">${preview || 'No preview available.'}${preview.length >= 200 ? '...' : ''}</p>
            </div>
            <div style="margin-top:20px;display:flex;gap:12px;flex-wrap:wrap;">
                <a href="${acceptUrl}" style="display:inline-block;padding:12px 20px;background:#16a34a;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">Accept and Receive Email</a>
                <a href="${declineUrl}" style="display:inline-block;padding:12px 20px;background:#ef4444;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">Decline</a>
            </div>
            <p style="margin-top:20px;font-size:12px;color:#6b7280;">This request expires in 24 hours.</p>
        </div>
    `;

    await transporter.sendMail({
        from: process.env.SMTP_USER,
        to: toEmail,
        subject: `Action required: ${user.name || 'Someone'} wants to send you a message via AgentForge`,
        html,
    });

    return request;
}

module.exports = { createPermissionRequest };
