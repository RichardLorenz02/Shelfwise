require("dotenv").config();

const bool = (v, d) =>
  v === undefined ? d : String(v).toLowerCase() === "true";
const int = (v, d) =>
  v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d;

const config = {
  env: process.env.NODE_ENV || "development",
  port: int(process.env.PORT, 5000),
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "8h",
  clientOrigin: process.env.CLIENT_ORIGIN || "http://localhost:5173",
  loanDays: int(process.env.LOAN_DAYS, 14),
  maxActiveLoans: int(process.env.MAX_ACTIVE_LOANS, 5),
  overdueSuspendLimit: int(process.env.OVERDUE_SUSPEND_LIMIT, 5), // this many overdue books suspends the account
  appealGraceDays: int(process.env.APPEAL_GRACE_DAYS, 7), // after an approved appeal, days before the rule applies again
  adminCanBorrow: bool(process.env.ADMIN_CAN_BORROW, false),
  allowRoleChanges: bool(process.env.ALLOW_ROLE_CHANGES, false),
};

if (config.env === "production" || process.env.VERCEL) {
  if (
    !config.jwtSecret ||
    config.jwtSecret.length < 32 ||
    /^(change-me|dev-only)/i.test(config.jwtSecret)
  ) {
    config.jwtSecret = null; // Auth fails closed; the public catalog can still load.
    console.error(
      "Authentication disabled: configure an independent, random JWT_SECRET of at least 32 characters.",
    );
  }
} else if (!config.jwtSecret) {
  config.jwtSecret = "dev-only-insecure-secret-change-me";
  if (config.env !== "test")
    console.warn(
      "JWT_SECRET is not set. Using an insecure development default.",
    );
}

module.exports = config;
