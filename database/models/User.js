const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    preferences: {
        theme: { type: String, default: 'dark' },
        language: { type: String, default: 'en' },
        voiceEnabled: { type: Boolean, default: false },
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
