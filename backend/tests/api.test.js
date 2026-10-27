/**
 * Acceptance tests T01–T10.
 * Runs against an isolated in-memory MongoDB.
 * Run from the project root: npm test
 */

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret";

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const app = require("../src/app");
const {
  connectDB,
  disconnectDB,
  User,
  Book,
  Session,
  BorrowingRecord: Borrowing,
} = require("lms-database");

let mongod;

const H = {
  "X-Requested-With": "XMLHttpRequest",
};

const agent = () => {
  const a = request.agent(app);
  const wrap = (method) => (url) => a[method](url).set(H);

  return {
    raw: a,
    get: wrap("get"),
    post: wrap("post"),
    put: wrap("put"),
    patch: wrap("patch"),
    delete: wrap("delete"),
  };
};

async function signUp(name, email) {
  const a = agent();

  const res = await a.post("/api/auth/register").send({
    name,
    email,
    password: "Curious readers explore 7",
  });

  expect(res.status).toBe(201);
  return a;
}

async function adminAgent() {
  await User.create({
    name: "Admin",
    email: "admin@t.test",
    role: "admin",
    passwordHash: await User.hashPassword("Admin@12345"),
  });

  const a = agent();

  const res = await a.post("/api/auth/login").send({
    email: "admin@t.test",
    password: "Admin@12345",
  });

  expect(res.status).toBe(200);
  return a;
}

const makeBook = (overrides = {}) =>
  Book.create({
    title: "Test Book",
    author: "Tester",
    category: "Fiction",
    totalCopies: 1,
    ...overrides,
  });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await connectDB(mongod.getUri());

  await Promise.all([
    User.syncIndexes(),
    Book.syncIndexes(),
    Borrowing.syncIndexes(),
    Session.syncIndexes(),
  ]);
});

afterAll(async () => {
  await disconnectDB();
  await mongod?.stop();
});

beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}),
    Book.deleteMany({}),
    Borrowing.deleteMany({}),
    Session.deleteMany({}),
  ]);
});

describe("Accounts", () => {
  test("T01 register, read session, sign out", async () => {
    const a = await signUp("Test User", "T@Example.com");

    const me = await a.get("/api/auth/me");

    expect(me.body.user.email).toBe("t@example.com");
    expect(me.body.user.passwordHash).toBeUndefined();

    expect((await a.post("/api/auth/logout")).status).toBe(200);
    expect((await a.get("/api/auth/me")).status).toBe(401);
  });

  test("T01 public registration can never grant admin", async () => {
    const a = agent();

    const res = await a.post("/api/auth/register").send({
      name: "Sneaky",
      email: "s@x.com",
      password: "Curious readers explore 7",
      role: "admin",
    });

    expect(res.body.user.role).toBe("user");
  });

  test("T02 duplicate email and invalid form are rejected safely", async () => {
    await signUp("A User", "dup@x.com");

    const duplicate = await agent().post("/api/auth/register").send({
      name: "B User",
      email: "dup@x.com",
      password: "Curious readers explore 7",
    });

    expect(duplicate.status).toBe(409);

    const invalid = await agent().post("/api/auth/register").send({
      name: "x",
      email: "nope",
      password: "short",
    });

    expect(invalid.status).toBe(422);
    expect(invalid.body.errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(invalid.body)).not.toMatch(/stack/i);
  });

  test("state-changing requests without the CSRF header are blocked", async () => {
    const res = await request(app).post("/api/auth/login").send({
      email: "a@b.com",
      password: "x",
    });

    expect(res.status).toBe(403);
  });
});

describe("Catalog and permissions", () => {
  test("T03 regular user cannot call admin book API", async () => {
    const user = await signUp("Reader", "r@x.com");

    const res = await user.post("/api/books").send({
      title: "X",
      author: "Y",
      category: "Z",
      totalCopies: 1,
    });

    expect(res.status).toBe(403);
    expect(await Book.countDocuments()).toBe(0);
  });

  test("T04 admin adds and edits a book; ISBN is validated", async () => {
    const admin = await adminAgent();

    const invalid = await admin.post("/api/books").send({
      title: "A",
      author: "B",
      category: "C",
      totalCopies: 2,
      isbn: "123",
    });

    expect(invalid.status).toBe(422);

    const created = await admin.post("/api/books").send({
      title: "A",
      author: "B",
      category: "C",
      totalCopies: 2,
      isbn: "978-0-306-40615-7",
    });

    expect(created.status).toBe(201);
    expect(created.body.book.availableCopies).toBe(2);

    const edited = await admin.put(`/api/books/${created.body.book.id}`).send({
      title: "A2",
      totalCopies: 3,
    });

    expect(edited.body.book.title).toBe("A2");
    expect(edited.body.book.availableCopies).toBe(3);
  });

  test("T05 search by author/category with pagination", async () => {
    await Book.insertMany(
      Array.from({ length: 15 }, (_, i) => ({
        title: `Vol ${i}`,
        author: "Ada Lovelace",
        category: "Science",
        totalCopies: 1,
        availableCopies: 1,
      })),
    );

    await makeBook({
      title: "Other",
      author: "Someone",
      category: "Art",
    });

    const res = await request(app).get("/api/books").query({
      q: "lovelace",
      limit: 10,
      page: 2,
    });

    expect(res.body.total).toBe(15);
    expect(res.body.data).toHaveLength(5);

    const category = await request(app)
      .get("/api/books")
      .query({ category: "Art" });

    expect(category.body.total).toBe(1);
  });

  test("archived books are hidden from the public catalog", async () => {
    const book = await makeBook({ isArchived: true });

    expect((await request(app).get("/api/books")).body.total).toBe(0);

    expect((await request(app).get(`/api/books/${book.id}`)).status).toBe(404);
  });
});

describe("Borrowing lifecycle", () => {
  test("T06 borrowing creates a loan and decrements availability", async () => {
    const user = await signUp("Reader", "r@x.com");
    const book = await makeBook({ totalCopies: 2 });

    const res = await user.post("/api/borrowings").send({
      bookId: book.id,
    });

    expect(res.status).toBe(201);
    expect(res.body.book.availableCopies).toBe(1);

    expect(
      new Date(res.body.loan.dueDate) > new Date(res.body.loan.borrowDate),
    ).toBe(true);
  });

  test("T06 borrower identity comes from the session, not the body", async () => {
    const mallory = await signUp("Mallory", "m@x.com");
    const victim = await signUp("Victim", "v@x.com");

    const victimId = (await victim.get("/api/auth/me")).body.user.id;
    const book = await makeBook();

    const res = await mallory.post("/api/borrowings").send({
      bookId: book.id,
      userId: victimId,
    });

    expect(res.body.loan.userId.email).toBe("m@x.com");
  });

  test("T07 unavailable book is denied and counts stay unchanged", async () => {
    const a = await signUp("Reader A", "a@x.com");
    const b = await signUp("Reader B", "b@x.com");
    const book = await makeBook({ totalCopies: 1 });

    const first = await a.post("/api/borrowings").send({
      bookId: book.id,
    });

    expect(first.status).toBe(201);

    const second = await b.post("/api/borrowings").send({
      bookId: book.id,
    });

    expect(second.status).toBe(409);
    expect((await Book.findById(book.id)).availableCopies).toBe(0);
  });

  test("concurrent borrows of the last copy: exactly one wins, stock never negative", async () => {
    const book = await makeBook({ totalCopies: 1 });

    const users = await Promise.all(
      Array.from({ length: 6 }, (_, i) => signUp(`U${i}`, `u${i}@x.com`)),
    );

    const results = await Promise.all(
      users.map((user) =>
        user.post("/api/borrowings").send({
          bookId: book.id,
        }),
      ),
    );

    expect(results.filter((result) => result.status === 201)).toHaveLength(1);

    expect((await Book.findById(book.id)).availableCopies).toBe(0);

    expect(await Borrowing.countDocuments({ bookId: book.id })).toBe(1);
  });

  test("a user cannot hold two copies of the same book", async () => {
    const reader = await signUp("Reader A", "a@x.com");
    const book = await makeBook({ totalCopies: 3 });

    await reader.post("/api/borrowings").send({
      bookId: book.id,
    });

    const again = await reader.post("/api/borrowings").send({
      bookId: book.id,
    });

    expect(again.status).toBe(409);
    expect((await Book.findById(book.id)).availableCopies).toBe(2);
  });

  test("T08/T09 admin returns once; repeat return is rejected without adding copies", async () => {
    const admin = await adminAgent();
    const reader = await signUp("Reader", "r@x.com");
    const book = await makeBook({ totalCopies: 2 });

    const borrowed = await reader.post("/api/borrowings").send({
      bookId: book.id,
    });

    const loan = borrowed.body.loan;
    const stranger = await signUp("Other reader", "other-return@x.com");

    const denied = await stranger
      .put(`/api/borrowings/${loan.id}`)
      .send({ status: "returned" });

    expect(denied.status).toBe(404);

    const first = await admin
      .put(`/api/borrowings/${loan.id}`)
      .send({ status: "returned" });

    expect(first.status).toBe(200);
    expect(first.body.loan.status).toBe("returned");
    expect((await Book.findById(book.id)).availableCopies).toBe(2);

    const second = await admin
      .put(`/api/borrowings/${loan.id}`)
      .send({ status: "returned" });

    expect(second.status).toBe(409);
    expect((await Book.findById(book.id)).availableCopies).toBe(2);

    const invalid = await admin
      .put("/api/borrowings/not-an-id")
      .send({ status: "returned" });

    expect(invalid.status).toBe(422);
  });

  test("readers return only their own loans and a repeat return does not add copies", async () => {
    const reader = await signUp("Returning reader", "self-return@x.com");

    const stranger = await signUp("Other reader", "self-return-other@x.com");

    const book = await makeBook({ totalCopies: 2 });

    const borrowed = await reader.post("/api/borrowings").send({
      bookId: book.id,
    });

    const loan = borrowed.body.loan;

    const denied = await stranger
      .put(`/api/borrowings/${loan.id}`)
      .send({ status: "returned" });

    expect(denied.status).toBe(404);

    const first = await reader
      .put(`/api/borrowings/${loan.id}`)
      .send({ status: "returned" });

    expect(first.status).toBe(200);
    expect(first.body.loan.status).toBe("returned");

    const repeated = await reader
      .put(`/api/borrowings/${loan.id}`)
      .send({ status: "returned" });

    expect(repeated.status).toBe(409);
    expect((await Book.findById(book.id)).availableCopies).toBe(2);

    const history = await reader.get("/api/borrowings?status=returned");

    expect(history.body.data.map((item) => item.id)).toContain(loan.id);
  });

  test("overdue = active loan with a due date before today", async () => {
    const admin = await adminAgent();
    const reader = await signUp("Reader", "r@x.com");

    const userId = (await reader.get("/api/auth/me")).body.user.id;
    const book = await makeBook();

    await Borrowing.create({
      userId,
      bookId: book.id,
      borrowDate: new Date(Date.now() - 20 * 864e5),
      dueDate: new Date(Date.now() - 6 * 864e5),
    });

    const res = await admin.get("/api/borrowings?status=overdue");

    expect(res.body.total).toBe(1);
    expect(res.body.data[0].displayStatus).toBe("overdue");

    const other = await makeBook({ title: "Another" });

    const denied = await reader.post("/api/borrowings").send({
      bookId: other.id,
    });

    expect(denied.status).toBe(409);
  });

  test("T10 users only see their own history", async () => {
    const a = await signUp("Reader A", "a@x.com");
    const b = await signUp("Reader B", "b@x.com");
    const book = await makeBook({ totalCopies: 2 });

    await a.post("/api/borrowings").send({
      bookId: book.id,
    });

    const aId = (await a.get("/api/auth/me")).body.user.id;

    expect((await b.get("/api/borrowings")).body.total).toBe(0);

    expect((await b.get(`/api/borrowings?userId=${aId}`)).status).toBe(403);

    expect((await a.get("/api/borrowings")).body.total).toBe(1);
  });
});

describe("Admin workspace", () => {
  test("dashboard and user list are admin-only", async () => {
    const reader = await signUp("Reader", "r@x.com");

    expect((await reader.get("/api/admin/dashboard")).status).toBe(403);

    expect((await reader.get("/api/users")).status).toBe(403);

    const admin = await adminAgent();
    const dashboard = await admin.get("/api/admin/dashboard");

    expect(dashboard.status).toBe(200);
    expect(dashboard.body.activity).toHaveLength(14);
  });

  test("role changes are off by default; suspending blocks sign-in", async () => {
    const admin = await adminAgent();
    const victim = await signUp("Victim", "v@x.com");

    const id = (await victim.get("/api/auth/me")).body.user.id;

    const roleChange = await admin
      .patch(`/api/users/${id}/status`)
      .send({ role: "admin" });

    expect(roleChange.status).toBe(403);

    const suspended = await admin
      .patch(`/api/users/${id}/status`)
      .send({ accountStatus: "suspended" });

    expect(suspended.status).toBe(200);
    expect((await victim.get("/api/auth/me")).status).toBe(403);
  });
});

describe("Overdue suspension and appeals", () => {
  const overdueLoans = async (userId, count) => {
    for (let i = 0; i < count; i++) {
      const book = await makeBook({
        title: `Late ${i}`,
        totalCopies: 1,
      });

      await Borrowing.create({
        userId,
        bookId: book.id,
        borrowDate: new Date(Date.now() - 30 * 864e5),
        dueDate: new Date(Date.now() - 16 * 864e5),
      });
    }
  };

  test("5 overdue books suspend the account; 4 do not", async () => {
    const four = await signUp("Four", "four@x.com");

    const fourId = (await four.get("/api/auth/me")).body.user.id;

    await overdueLoans(fourId, 4);

    expect((await four.get("/api/auth/me")).status).toBe(200);

    const five = await signUp("Five", "five@x.com");

    const fiveId = (await five.get("/api/auth/me")).body.user.id;

    await overdueLoans(fiveId, 5);

    expect((await five.get("/api/auth/me")).status).toBe(403);

    const login = await agent().post("/api/auth/login").send({
      email: "five@x.com",
      password: "Curious readers explore 7",
    });

    expect(login.status).toBe(403);
    expect(login.body.suspended).toBe(true);
    expect(login.body.reason).toBe("overdue");
  });

  test("a suspended reader can appeal, and a librarian can approve it", async () => {
    const admin = await adminAgent();
    const reader = await signUp("Late Reader", "late@x.com");

    const id = (await reader.get("/api/auth/me")).body.user.id;

    await overdueLoans(id, 5);

    expect((await reader.get("/api/auth/me")).status).toBe(403);

    const anonymous = agent();

    const wrongPassword = await anonymous.post("/api/auth/appeal").send({
      email: "late@x.com",
      password: "wrong-pass1",
      message: "Please restore my account.",
    });

    expect(wrongPassword.status).toBe(401);

    const shortMessage = await anonymous.post("/api/auth/appeal").send({
      email: "late@x.com",
      password: "Curious readers explore 7",
      message: "short",
    });

    expect(shortMessage.status).toBe(422);

    const appeal = await anonymous.post("/api/auth/appeal").send({
      email: "late@x.com",
      password: "Curious readers explore 7",
      message: "I was travelling and will return the books.",
    });

    expect(appeal.status).toBe(201);

    const duplicate = await anonymous.post("/api/auth/appeal").send({
      email: "late@x.com",
      password: "Curious readers explore 7",
      message: "Sending a second appeal anyway.",
    });

    expect(duplicate.status).toBe(409);

    const pending = await admin.get("/api/users?appeal=pending");

    expect(pending.body.total).toBe(1);

    const approved = await admin
      .patch(`/api/users/${id}/appeal`)
      .send({ decision: "approve" });

    expect(approved.status).toBe(200);

    const login = await agent().post("/api/auth/login").send({
      email: "late@x.com",
      password: "Curious readers explore 7",
    });

    expect(login.status).toBe(200);
  });

  test("a denied appeal keeps the account suspended and can be sent again", async () => {
    const admin = await adminAgent();
    const reader = await signUp("Denied", "den@x.com");

    const id = (await reader.get("/api/auth/me")).body.user.id;

    await admin
      .patch(`/api/users/${id}/status`)
      .send({ accountStatus: "suspended" });

    const anonymous = agent();

    await anonymous.post("/api/auth/appeal").send({
      email: "den@x.com",
      password: "Curious readers explore 7",
      message: "I would like my account back please.",
    });

    const denied = await admin.patch(`/api/users/${id}/appeal`).send({
      decision: "deny",
      note: "Return the books first.",
    });

    expect(denied.status).toBe(200);

    const login = await agent().post("/api/auth/login").send({
      email: "den@x.com",
      password: "Curious readers explore 7",
    });

    expect(login.status).toBe(403);
    expect(login.body.appealStatus).toBe("denied");

    const newAppeal = await anonymous.post("/api/auth/appeal").send({
      email: "den@x.com",
      password: "Curious readers explore 7",
      message: "The books are returned now, thank you.",
    });

    expect(newAppeal.status).toBe(201);
  });
});

describe("Catalog data", () => {
  test("books on loan expose nextAvailableDate", async () => {
    const reader = await signUp("Reader", "r@x.com");
    const book = await makeBook({ totalCopies: 1 });

    await reader.post("/api/borrowings").send({
      bookId: book.id,
    });

    const list = await agent().get("/api/books?limit=100");

    expect(list.body.data[0].nextAvailableDate).toBeTruthy();

    const one = await agent().get(`/api/books/${book.id}`);

    expect(one.body.book.nextAvailableDate).toBeTruthy();
  });
});
