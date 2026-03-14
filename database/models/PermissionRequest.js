const mongoose = require('mongoose');

const permissionRequestSchema = new mongoose.Schema({
    token: { type: String, required: true, unique: true, index: true },
    fromUserId: { type: String, required: true, index: true },
    fromUserName: { type: String, default: '' },
    fromUserEmail: { type: String, default: '' },
    toEmail: { type: String, required: true, index: true },
    pendingEmailContent: { type: String, default: '' },
    pendingSubject: { type: String, default: '' },
    expiresAt: { type: Date, required: true, index: true },
    status: { type: String, enum: ['pending', 'accepted', 'declined', 'expired'], default: 'pending', index: true },
    createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('PermissionRequest', permissionRequestSchema);
