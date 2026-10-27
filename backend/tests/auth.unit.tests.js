process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret";
const sessions = new Map();
const user = {
  _id: "507f1f77bcf86cd799439011",
  id: "507f1f77bcf86cd799439011",
  role: "user",
  accountStatus: "active",
};
jest.mock("lms-database", () => ({
  User: {
    findById: (id) => ({ select: async () => (id === user.id ? user : null) }),
  },
  Session: {
    create: async (session) => sessions.set(session.tokenHash, session),
    findOne: async (query) => {
      const s = sessions.get(query.tokenHash);
      return s && s.expiresAt > query.expiresAt.$gt ? s : null;
    },
    deleteOne: async (query) => sessions.delete(query.tokenHash),
    deleteMany: async ({ userId }) => {
      for (const [key, s] of sessions)
        if (s.userId === userId) sessions.delete(key);
    },
  },
}));
jest.mock("../src/services/suspensionService", () => ({
  enforceOverdueSuspension: async () => {},
}));
const jwt = require("jsonwebtoken");
const auth = require("../src/middleware/auth");
const response = () => ({
  cookie(name, token, options) {
    this.token = token;
    this.options = options;
  },
});
const req = (token) => ({ cookies: { token }, get: () => "" });
async function allowed(token) {
  let error;
  const r = req(token);
  await auth.protect(r, {}, (err) => {
    error = err;
  });
  return { user: r.user, error };
}
beforeEach(() => {
  sessions.clear();
  user.sessionVersion = 0;
});
test("reader cookies are HttpOnly and expire with the signed token; JWT claims are restricted", async () => {
  const res = response();
  await auth.issueSession(res, user);
  expect(res.options.httpOnly).toBe(true);
  expect(res.options.sameSite).toBe("lax");
  expect(res.options.maxAge).toBeGreaterThan(7.9 * 3600000);
  const claims = jwt.verify(res.token, process.env.JWT_SECRET, {
    algorithms: ["HS256"],
    issuer: "minerva",
    audience: "minerva-web",
  });
  expect(claims.sub).toBe(user.id);
  expect(claims.jti).toHaveLength(64);
  expect((await allowed(res.token)).user).toBe(user);
  expect([...sessions.keys()]).not.toContain(res.token);
});
test("librarian tokens have a one hour absolute lifetime", async () => {
  const res = response();
  await auth.issueSession(res, { ...user, role: "admin" });
  const payload = jwt.decode(res.token);
  expect(payload.exp - payload.iat).toBe(3600);
});
test("revoking one token rejects its replay without ending another session", async () => {
  const first = response(),
    second = response();
  await auth.issueSession(first, user);
  await auth.issueSession(second, user);
  expect(first.token).not.toBe(second.token);
  await auth.revokeSession(req(first.token));
  expect((await allowed(first.token)).error.status).toBe(401);
  expect((await allowed(second.token)).user).toBe(user);
});
test("revoking all sessions rejects every previously issued token", async () => {
  const first = response(),
    second = response();
  await auth.issueSession(first, user);
  await auth.issueSession(second, user);
  await auth.revokeAllSessions(user._id);
  expect((await allowed(first.token)).error.status).toBe(401);
  expect((await allowed(second.token)).error.status).toBe(401);
});
test("a password version change invalidates even a session issued by a concurrent old login", async () => {
  const res = response();
  await auth.issueSession(res, user);
  user.sessionVersion = 1;
  expect((await allowed(res.token)).error.status).toBe(401);
});
test("expired persisted sessions are denied before TTL cleanup", async () => {
  const res = response();
  await auth.issueSession(res, user);
  for (const s of sessions.values()) s.expiresAt = new Date(0);
  expect((await allowed(res.token)).error.status).toBe(401);
});
test("production authentication fails closed without an independent signing secret", () => {
  const oldEnv = process.env.NODE_ENV,
    oldSecret = process.env.JWT_SECRET;
  process.env.NODE_ENV = "production";
  delete process.env.JWT_SECRET;
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    jest.isolateModules(() =>
      expect(require("../src/config/env").jwtSecret).toBeNull(),
    );
  } finally {
    process.env.NODE_ENV = oldEnv;
    process.env.JWT_SECRET = oldSecret;
    log.mockRestore();
  }
});
