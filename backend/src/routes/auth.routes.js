const router = require("express").Router();
const { authLimiter, accountLimiter } = require("../middleware/authLimiter");
const { body } = require("express-validator");
const validate = require("../middleware/validate");
const { protect, requireAuthConfig } = require("../middleware/auth");
const c = require("../controllers/auth.controller");

router.use((req, res, next) =>
  req.path === "/logout" ? next() : requireAuthConfig(req, res, next),
);

const email = body("email")
  .isString()
  .trim()
  .toLowerCase()
  .isEmail()
  .withMessage("Enter a valid email address.");

router.post(
  "/register",
  authLimiter,
  [
    body("name")
      .isString()
      .trim()
      .isLength({ min: 2, max: 80 })
      .withMessage("Enter your full name (2 to 80 characters)."),
    email,
    body("password")
      .isString()
      .bail()
      .isLength({ min: 15 })
      .withMessage("Use a passphrase of at least 15 characters.")
      .custom((value) => Buffer.byteLength(value, "utf8") <= 72)
      .withMessage("Password must be at most 72 UTF-8 bytes."),
  ],
  validate,
  accountLimiter,
  c.register,
);
router.post(
  "/login",
  authLimiter,
  [
    email,
    body("password")
      .isString()
      .bail()
      .notEmpty()
      .withMessage("Enter your password.")
      .custom((v) => Buffer.byteLength(v, "utf8") <= 72)
      .withMessage("Password must be at most 72 UTF-8 bytes."),
  ],
  validate,
  accountLimiter,
  c.login,
);
router.post(
  "/appeal",
  authLimiter,
  [
    email,
    body("password")
      .isString()
      .bail()
      .notEmpty()
      .withMessage("Enter your password.")
      .custom((v) => Buffer.byteLength(v, "utf8") <= 72)
      .withMessage("Password must be at most 72 UTF-8 bytes."),
    body("message")
      .isString()
      .trim()
      .isLength({ min: 10, max: 1000 })
      .withMessage("Explain your situation in 10 to 1000 characters."),
  ],
  validate,
  accountLimiter,
  c.appeal,
);
router.post("/logout", c.logout);
router.get("/me", protect, c.me);

module.exports = router;
