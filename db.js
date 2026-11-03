const mongoose = require("mongoose");

async function connectDB() {
  try {
    console.log("Attempting to connect to MongoDB...");
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("Successfully connected to MongoDB Atlas! 🎉");
  } catch (error) {
    console.error("Connection error:", error.message);
    throw error;
  }
}

// Allow running this file directly (`node db.js`) without double-connecting
// when it is imported from index.js.
if (require.main === module) {
  require("dotenv").config();
  connectDB();
}

module.exports = connectDB;
