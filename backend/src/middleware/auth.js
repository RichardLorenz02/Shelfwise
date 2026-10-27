const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { User, Session } = require("lms-database");
const config = require("../config/env");
const AppError = require("../utils/AppError");
const asyncHandler = require("../utils/asyncHandler");
const { enforceOverdueSuspension } = require("../services/suspensionService");

const hashToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");
const tokenFrom = (req) => {
  const header = req.get("authorization") || "";
  return (
    req.cookies?.token ||
    (header.startsWith("Bearer ") ? header.slice(7) : null)
  );
};
const ensureConfigured = () => {
  if (!config.jwtSecret)
    throw new AppError(
      "Sign-in is temporarily unavailable. Please contact the library.",
      503,
    );
};
exports.requireAuthConfig = (_req, _res, next) => {
  try {
    ensureConfigured();
    next();
  } catch (err) {
    next(err);
  }
};

async function authenticate(req) {
  const token = tokenFrom(req);
  if (!token) return null;
  ensureConfigured();
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret, {
      algorithms: ["HS256"],
      issuer: "minerva",
      audience: "minerva-web",
    });
  } catch {
    throw new AppError("Your session has ended. Sign in again.", 401);
  }
  const session = await Session.findOne({
    tokenHash: hashToken(token),
    expiresAt: { $gt: new Date() },
  });
  if (!session || String(session.userId) !== payload.sub)
    throw new AppError("Your session has ended. Sign in again.", 401);
  const user = await User.findById(payload.sub).select("+sessionVersion");
  if (!user || payload.ver !== (user.sessionVersion || 0))
    throw new AppError("Your session has ended. Sign in again.", 401);
  await enforceOverdueSuspension(user);
  if (user.accountStatus !== "active")
    throw new AppError(
      "This account is suspended. Sign in to send an appeal.",
      403,
      undefined,
      { suspended: true },
    );
  return user;
}

exports.protect = asyncHandler(async (req, _res, next) => {
  const user = await authenticate(req);
  if (!user) throw new AppError("Sign in to continue.", 401);
  req.user = user;
  next();
});

exports.optionalAuth = asyncHandler(async (req, _res, next) => {
  try {
    req.user = await authenticate(req);
  } catch {
    req.user = null;
  }
  next();
});

exports.requireRole =
  (...roles) =>
  (req, _res, next) =>
    roles.includes(req.user?.role)
      ? next()
      : next(new AppError("You do not have permission to do that.", 403));

const cookieOptions = () => ({
  httpOnly: true,
  sameSite: "lax",
  secure: config.env === "production" || !!process.env.VERCEL,
  path: "/",
});

exports.issueSession = async (res, user) => {
  ensureConfigured();
  const token = jwt.sign(
    { sub: user.id, ver: user.sessionVersion || 0 },
    config.jwtSecret,
    {
      algorithm: "HS256",
      issuer: "minerva",
      audience: "minerva-web",
      jwtid: crypto.randomBytes(32).toString("hex"),
      expiresIn: user.role === "admin" ? "1h" : config.jwtExpiresIn,
    },
  );
  const expiresAt = new Date(jwt.decode(token).exp * 1000);
  await Session.create({
    tokenHash: hashToken(token),
    userId: user._id,
    expiresAt,
  });
  res.cookie("token", token, {
    ...cookieOptions(),
    maxAge: Math.max(0, expiresAt.getTime() - Date.now()),
  });
};

exports.revokeSession = async (req) => {
  const token = tokenFrom(req);
  if (token) await Session.deleteOne({ tokenHash: hashToken(token) });
};
exports.revokeAllSessions = (userId) => Session.deleteMany({ userId });
exports.clearSession = (res) => res.clearCookie("token", cookieOptions());
