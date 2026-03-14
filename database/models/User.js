const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    googleCalendar: {
        refreshToken: { type: String, default: '' },
        accessToken: { type: String, default: '' },
        tokenExpiry: { type: Date, default: null },
        connected: { type: Boolean, default: false },
        accountEmail: { type: String, default: '' },
    },
    notifications: {
        emailEnabled: { type: Boolean, default: false },
        emailAddress: { type: String, default: '' },
        notifyOnPipelineComplete: { type: Boolean, default: true },
        notifyOnScheduledTask: { type: Boolean, default: true },
        notifyOnCalendarCreated: { type: Boolean, default: true },
    },
    preferences: {
        theme: { type: String, default: 'dark' },
        language: { type: String, default: 'en' },
        voiceEnabled: { type: Boolean, default: false },
        showPipelineRecommendations: { type: Boolean, default: true },
        showEmailField: { type: Boolean, default: true },
        autoSendEmail: { type: Boolean, default: false },
        voiceEnabledByDefault: { type: Boolean, default: false },
        autoOptimisePrompts: { type: Boolean, default: true },
        voiceControlEnabled: { type: Boolean, default: false },
        voiceContinuousMode: { type: Boolean, default: true },
        voiceMuted: { type: Boolean, default: false },
        voiceRate: { type: Number, default: 1.0 },
        voicePitch: { type: Number, default: 1.0 },
        voiceRecognitionLanguage: { type: String, default: 'en-US' },
        voiceOnboarded: { type: Boolean, default: false },
    },
    createdAt: { type: Date, default: Date.now },
});

// Virtual id
userSchema.virtual('id').get(function () {
    return this._id.toString();
});

// Return safe object without sensitive fields
userSchema.methods.toSafeObject = function () {
    const obj = this.toObject({ virtuals: true });
    delete obj.passwordHash;
    return obj;
};

module.exports = mongoose.model('User', userSchema);
