const mongoose = require("mongoose");

// Only a digest is stored. A database read cannot recover a usable session token.
const schema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    expiresAt: { type: Date, required: true, expires: 0 },
  },
  { timestamps: true },
);
module.exports = mongoose.model("Session", schema);
