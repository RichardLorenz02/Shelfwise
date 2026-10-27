process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret";
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const app = require("../src/app");
const { connectDB, disconnectDB, User, Session } = require("lms-database");
const { MongoRateLimitStore } = require("../src/middleware/authLimiter");
const { mongoose } = require("lms-database");
const H = { "X-Requested-With": "XMLHttpRequest" };
const password = "Curious readers explore 7";
const cookie = (res) =>
  res.headers["set-cookie"].find((c) => c.startsWith("token=")).split(";")[0];
let mongo;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await connectDB(mongo.getUri());
  await Session.init();
});
afterAll(async () => {
  await disconnectDB();
  await mongo?.stop();
});
beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Session.deleteMany({})]);
});
async function register() {
  const r = await request(app)
    .post("/api/auth/register")
    .set(H)
    .send({ name: "A Reader", email: "a@example.test", password });
  expect(r.status).toBe(201);
  return cookie(r);
}
test("logout revokes a copied token on the server, while another device remains signed in", async () => {
  const first = await register();
  const secondResponse = await request(app)
    .post("/api/auth/login")
    .set(H)
    .send({ email: "a@example.test", password });
  const second = cookie(secondResponse);
  expect(second).not.toBe(first);
  expect(
    (await request(app).post("/api/auth/logout").set(H).set("Cookie", first))
      .status,
  ).toBe(200);
  expect(
    (await request(app).get("/api/auth/me").set("Cookie", first)).status,
  ).toBe(401);
  expect(
    (await request(app).get("/api/auth/me").set("Cookie", second)).status,
  ).toBe(200);
});
test("password change revokes every old session and rotates the current browser session", async () => {
  const old = await register();
  const second = cookie(
    await request(app)
      .post("/api/auth/login")
      .set(H)
      .send({ email: "a@example.test", password }),
  );
  const changed = await request(app)
    .put("/api/users/me")
    .set(H)
    .set("Cookie", old)
    .send({
      currentPassword: password,
      newPassword: "A different reading chapter",
    });
  expect(changed.status).toBe(200);
  expect(
    (await request(app).get("/api/auth/me").set("Cookie", old)).status,
  ).toBe(401);
  expect(
    (await request(app).get("/api/auth/me").set("Cookie", second)).status,
  ).toBe(401);
  expect(
    (await request(app).get("/api/auth/me").set("Cookie", cookie(changed)))
      .status,
  ).toBe(200);
  expect(JSON.stringify(changed.body)).not.toContain("passwordHash");
});
test("new passwords reject bcrypt byte truncation and short passphrases", async () => {
  for (const value of ["too short", "界".repeat(25)]) {
    const r = await request(app)
      .post("/api/auth/register")
      .set(H)
      .send({ name: "Reader", email: "x@example.test", password: value });
    expect(r.status).toBe(422);
  }
  expect(await User.countDocuments()).toBe(0);
});
test("unknown user and incorrect password receive the same response", async () => {
  await register();
  const a = await request(app)
    .post("/api/auth/login")
    .set(H)
    .send({ email: "missing@example.test", password: "incorrect" });
  const b = await request(app)
    .post("/api/auth/login")
    .set(H)
    .send({ email: "a@example.test", password: "incorrect" });
  expect(a.status).toBe(401);
  expect(b.status).toBe(401);
  expect(a.body).toEqual(b.body);
});
test("session expiry is checked even before MongoDB TTL cleanup", async () => {
  const token = await register();
  await Session.updateMany({}, { expiresAt: new Date(0) });
  expect(
    (await request(app).get("/api/auth/me").set("Cookie", token)).status,
  ).toBe(401);
});
test("independent rate limiter instances share atomic counters and reset expired windows", async () => {
  const a = new MongoRateLimitStore("test-shared"),
    b = new MongoRateLimitStore("test-shared");
  a.init({ windowMs: 900000 });
  b.init({ windowMs: 900000 });
  await a.resetKey("reader@example.test");
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      (i % 2 ? a : b).increment("reader@example.test"),
    ),
  );
  expect(Math.max(...results.map((r) => r.totalHits))).toBe(20);
  const stored = await mongoose.connection
    .collection("auth_attempts")
    .findOne({ _id: a.key("reader@example.test") });
  expect(stored._id).not.toContain("reader@example.test");
  await mongoose.connection
    .collection("auth_attempts")
    .updateOne({ _id: stored._id }, { $set: { expiresAt: new Date(0) } });
  expect((await b.increment("reader@example.test")).totalHits).toBe(1);
});
test("production never derives the signing secret from the MongoDB URI", () => {
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
