const mongoose = require('mongoose');

const scheduleHistorySchema = new mongoose.Schema({
    scheduleId: { type: String, required: true, index: true },
    ranAt: { type: Date, default: Date.now },
    summary: { type: String },
    success: { type: Boolean, default: true },
});

module.exports = mongoose.model('ScheduleHistory', scheduleHistorySchema);
