// // Load required packages
// var mongoose = require('mongoose');

// // Define our user schema
// var UserSchema = new mongoose.Schema({
//     name: String
// });

// // Export the Mongoose model
// module.exports = mongoose.model('User', UserSchema);


const mongoose = require('mongoose');

// Define User Schema with all required fields
const UserSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'User name is required']
  },
  email: {
    type: String,
    required: [true, 'User email is required'],
    unique: true,
    lowercase: true,
    trim: true
  },
  pendingTasks: {
    type: [String],  // Array of task IDs
    default: []
  },
  dateCreated: {
    type: Date,
    default: Date.now  // Automatically set to current date
  }
});

// Create indexes for better query performance
UserSchema.index({ email: 1 });
UserSchema.index({ name: 1 });

// Export the model
module.exports = mongoose.model('User', UserSchema);