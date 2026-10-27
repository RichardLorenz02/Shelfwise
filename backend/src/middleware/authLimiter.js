const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const { mongoose } = require("lms-database");
const config = require("../config/env");

/** Shared, atomic counters across Vercel instances. Expired windows reset even before TTL cleanup. */
class MongoRateLimitStore {
  constructor(prefix) {
    this.prefix = prefix;
    this.localKeys = false;
  }
  init(options) {
    this.windowMs = options.windowMs;
  }
  async collection() {
    const collection = mongoose.connection.collection("auth_attempts");
    this.indexReady ||= collection
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
      .catch((err) => {
        this.indexReady = null;
        throw err;
      });
    await this.indexReady;
    return collection;
  }
  key(key) {
    return (
      this.prefix + ":" + crypto.createHash("sha256").update(key).digest("hex")
    );
  }
  async increment(key) {
    const collection = await this.collection(),
      now = new Date();
    const expired = { $lte: [{ $ifNull: ["$expiresAt", new Date(0)] }, now] };
    const doc = await collection.findOneAndUpdate(
      { _id: this.key(key) },
      [
        {
          $set: {
            totalHits: {
              $cond: [
                expired,
                1,
                { $add: [{ $ifNull: ["$totalHits", 0] }, 1] },
              ],
            },
            expiresAt: {
              $cond: [
                expired,
                new Date(now.getTime() + this.windowMs),
                "$expiresAt",
              ],
            },
          },
        },
      ],
      { upsert: true, returnDocument: "after", includeResultMetadata: false },
    );
    return { totalHits: doc.totalHits, resetTime: doc.expiresAt };
  }
  async decrement(key) {
    const collection = await this.collection();
    await collection.updateOne({ _id: this.key(key) }, [
      { $set: { totalHits: { $max: [0, { $subtract: ["$totalHits", 1] }] } } },
    ]);
  }
  async resetKey(key) {
    const collection = await this.collection();
    await collection.deleteOne({ _id: this.key(key) });
  }
}
const shared = config.env === "production" || !!process.env.VERCEL;
const options = {
  windowMs: 15 * 60 * 1000,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  skip: () => config.env === "test",
  message: { message: "Too many attempts. Wait 15 minutes and try again." },
};
const authLimiter = rateLimit({
  ...options,
  limit: 30,
  ...(shared && { store: new MongoRateLimitStore("auth-ip") }),
});
const accountLimiter = rateLimit({
  ...options,
  limit: 10,
  keyGenerator: (req) =>
    String(req.user?.email || req.body?.email || "")
      .trim()
      .toLowerCase(),
  ...(shared && { store: new MongoRateLimitStore("auth-account") }),
});
module.exports = { authLimiter, accountLimiter, MongoRateLimitStore };
