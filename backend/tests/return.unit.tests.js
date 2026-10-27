process.env.NODE_ENV = "test";
const mockLoans = new Map();
const mockBooks = new Map();
let mockFailInventory = false;
const matches = (loan, query) =>
  loan &&
  Object.entries(query).every(([key, value]) => {
    if (value instanceof Date) return +loan[key] === +value;
    return String(loan[key]) === String(value);
  });
jest.mock("lms-database", () => ({
  BorrowingRecord: {
    findOneAndUpdate: async (filter, update) => {
      const loan = mockLoans.get(String(filter._id));
      if (!matches(loan, filter)) return null;
      Object.assign(loan, update.$set);
      return { ...loan, populate: async () => {} };
    },
    exists: async (filter) =>
      matches(mockLoans.get(String(filter._id)), filter),
    updateOne: async (filter, update) => {
      const loan = mockLoans.get(String(filter._id));
      if (matches(loan, filter)) Object.assign(loan, update.$set);
    },
  },
  Book: {
    findOneAndUpdate: async (filter, update) => {
      if (mockFailInventory) {
        mockFailInventory = false;
        throw Error("Inventory unavailable");
      }
      const book = mockBooks.get(String(filter._id));
      if (!book || book.availableCopies >= book.totalCopies) return null;
      book.availableCopies += update.$inc.availableCopies;
      return { ...book };
    },
    findById: async (id) => mockBooks.get(String(id)),
  },
}));
jest.mock("../src/middleware/auth", () => ({
  protect: (req, res, next) => {
    const id = req.get("x-test-user");
    if (!id) return res.status(401).json({ message: "Sign in to continue." });
    req.user = { _id: id, role: req.get("x-test-role") || "user" };
    next();
  },
  requireRole:
    (...roles) =>
    (req, res, next) =>
      roles.includes(req.user.role) ? next() : res.sendStatus(403),
}));
// Run the actual route/validator/controller chain in-process; no HTTP socket or MongoDB.
const router = require("../src/routes/borrowings.routes");
const readerId = "507f1f77bcf86cd799439011";
const strangerId = "507f1f77bcf86cd799439012";
const adminId = "507f1f77bcf86cd799439013";
const bookId = "507f1f77bcf86cd799439014";
const loanId = "507f1f77bcf86cd799439015";
const sendReturn = (
  id = readerId,
  role = "user",
  body = { status: "returned" },
  loan = loanId,
) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Route did not finish")), 3000);
    const finish = (status, value) => {
      clearTimeout(timer);
      resolve({ status, body: JSON.parse(JSON.stringify(value)) });
    };
    const req = {
      method: "PUT",
      url: "/" + loan,
      body,
      query: {},
      headers: {},
      get: (name) =>
        name === "x-test-user" ? id : name === "x-test-role" ? role : undefined,
    };
    const res = {
      code: 200,
      status(code) {
        this.code = code;
        return this;
      },
      json(value) {
        finish(this.code, value);
      },
      sendStatus(code) {
        finish(code, {});
      },
    };
    router.handle(req, res, (error) =>
      error
        ? finish(error.status || 500, { message: error.message })
        : finish(404, {}),
    );
  });
beforeEach(() => {
  mockFailInventory = false;
  mockLoans.clear();
  mockBooks.clear();
  mockLoans.set(loanId, {
    _id: loanId,
    id: loanId,
    userId: readerId,
    bookId,
    status: "borrowed",
    returnDate: null,
    returnedBy: null,
  });
  mockBooks.set(bookId, { _id: bookId, totalCopies: 2, availableCopies: 1 });
});
test("a reader returns their own loan and restores one copy", async () => {
  const res = await sendReturn();
  expect(res.status).toBe(200);
  expect(res.body.loan.status).toBe("returned");
  expect(res.body.loan.returnedBy).toBe(readerId);
  expect(res.body.loan.returnDate).toBeTruthy();
  expect(mockBooks.get(bookId).availableCopies).toBe(2);
});
test("someone else cannot return a loan or reveal its existence", async () => {
  const res = await sendReturn(strangerId);
  expect(res.status).toBe(404);
  expect(res.body.message).toBe("Loan not found.");
  expect(mockLoans.get(loanId).status).toBe("borrowed");
  expect(mockBooks.get(bookId).availableCopies).toBe(1);
});
test("a forged userId in the body cannot change ownership", async () => {
  expect(
    (
      await sendReturn(strangerId, "user", {
        status: "returned",
        userId: readerId,
      })
    ).status,
  ).toBe(404);
  expect(mockBooks.get(bookId).availableCopies).toBe(1);
});
test("a librarian can still process another reader's return", async () => {
  expect((await sendReturn(adminId, "admin")).status).toBe(200);
  expect(mockLoans.get(loanId).returnedBy).toBe(adminId);
});
test("duplicate and concurrent returns increment inventory only once", async () => {
  const results = await Promise.all([
    sendReturn(),
    sendReturn(adminId, "admin"),
  ]);
  expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
  expect((await sendReturn()).status).toBe(409);
  expect(mockBooks.get(bookId).availableCopies).toBe(2);
});
test("anonymous callers and invalid requests cannot process a return", async () => {
  expect((await sendReturn(null)).status).toBe(401);
  expect(
    (await sendReturn(readerId, "user", { status: "borrowed" })).status,
  ).toBe(422);
  expect(
    (await sendReturn(readerId, "user", { status: "returned" }, "not-an-id"))
      .status,
  ).toBe(422);
  expect(mockBooks.get(bookId).availableCopies).toBe(1);
});
test("a missing loan is a 404", async () => {
  expect(
    (
      await sendReturn(
        readerId,
        "user",
        { status: "returned" },
        "507f1f77bcf86cd799439099",
      )
    ).status,
  ).toBe(404);
});
test("returns do not exceed total copies even when inventory is already full", async () => {
  mockBooks.get(bookId).availableCopies = 2;
  expect((await sendReturn()).status).toBe(200);
  expect(mockBooks.get(bookId).availableCopies).toBe(2);
});
test("an inventory failure restores the active loan so the return can be retried", async () => {
  mockFailInventory = true;
  expect((await sendReturn()).status).toBe(500);
  expect(mockLoans.get(loanId).status).toBe("borrowed");
  expect(mockLoans.get(loanId).returnDate).toBeNull();
  expect(mockLoans.get(loanId).returnedBy).toBeNull();
  expect(mockBooks.get(bookId).availableCopies).toBe(1);
  expect((await sendReturn()).status).toBe(200);
  expect(mockBooks.get(bookId).availableCopies).toBe(2);
});
