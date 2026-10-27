import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  AlertCircle,
  ArrowUpRight,
  BookOpen,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  LockKeyhole,
  ShieldAlert,
} from "lucide-react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { Field } from "../components/Ui";

function AuthFrame({ children }) {
  return (
    <div className="auth-premium">
      <aside className="auth-story">
        <span className="eyebrow">
          <BookOpen size={15} /> THE MINERVA LIBRARY
        </span>
        <h2>
          A little curiosity.
          <br />A whole <em>new world.</em>
        </h2>
        <p>
          A place to discover, to get lost in a good book, and to find your next
          chapter.
        </p>
        <div className="auth-books" aria-hidden="true">
          <i>THE ART OF READING</i>
          <i>STORIES & IDEAS</i>
          <i>A WORLD WITHIN</i>
          <i>MINERVA</i>
        </div>
        <Link to="/catalog" className="auth-explore">
          Explore the collection <ArrowUpRight size={18} />
        </Link>
      </aside>
      {children}
    </div>
  );
}

function PasswordInput({
  id,
  value,
  onChange,
  invalid,
  autoComplete,
  describedBy,
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="input-icon" style={{ position: "relative" }}>
      <input
        id={id}
        name={id}
        className="input"
        style={{ paddingLeft: 14, paddingRight: 48 }}
        type={show ? "text" : "password"}
        value={value}
        onChange={onChange}
        autoComplete={autoComplete}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
      />
      <button
        type="button"
        className="btn btn-ghost btn-icon btn-sm"
        style={{ position: "absolute", right: 4, top: 5 }}
        onClick={() => setShow((s) => !s)}
        aria-label={show ? "Hide password" : "Show password"}
      >
        {show ? <EyeOff size={17} /> : <Eye size={17} />}
      </button>
    </div>
  );
}

/** Shown when a suspended reader tries to sign in: explains why and lets them appeal. */
function Suspended({ info, creds, onBack }) {
  const toast = useToast();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(info.appealStatus); // null | pending | denied
  const pending = status === "pending";

  const send = async (e) => {
    e.preventDefault();
    setError("");
    if (message.trim().length < 10)
      return setError(
        "Please explain your situation in at least 10 characters.",
      );
    setBusy(true);
    try {
      await api.post("/auth/appeal", {
        email: creds.email,
        password: creds.password,
        message: message.trim(),
      });
      setStatus("pending");
      toast.success("Appeal sent. A librarian will review it.");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame>
      <div className="auth-card panel panel-pad">
        <h1>Account suspended</h1>
        <div
          className="alert alert-error"
          role="alert"
          style={{ marginTop: 14 }}
        >
          <ShieldAlert size={18} /> {info.message}
        </div>
        {pending ? (
          <div
            className="alert alert-info"
            role="status"
            style={{ marginTop: 14 }}
          >
            <CheckCircle2 size={18} /> Your appeal is waiting for a librarian.
            You’ll be able to sign in as soon as it is approved.
          </div>
        ) : (
          <form
            onSubmit={send}
            noValidate
            className="stack"
            style={{ "--gap": "14px", marginTop: 14 }}
          >
            {status === "denied" && (
              <div className="alert alert-warn" role="status">
                <AlertCircle size={18} /> Your last appeal was declined
                {info.appealMessage ? `: ${info.appealMessage}` : "."} You can
                send a new one.
              </div>
            )}
            {error && (
              <div className="alert alert-error" role="alert">
                <AlertCircle size={18} /> {error}
              </div>
            )}
            <Field
              label="Appeal to a librarian"
              htmlFor="appeal"
              hint="Say what happened and when the books will be back. Up to 1000 characters."
            >
              <textarea
                id="appeal"
                className="textarea"
                maxLength={1000}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </Field>
            <button
              className="btn btn-primary btn-lg"
              style={{ width: "100%" }}
              disabled={busy}
            >
              {busy && <Loader2 size={18} className="spin" />} Send appeal
            </button>
          </form>
        )}
        <p className="muted" style={{ marginTop: 18 }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onBack}
          >
            Back to sign in
          </button>
        </p>
      </div>
    </AuthFrame>
  );
}

export function Login() {
  const { login } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({ email: "", password: "" });
  const [error, setError] = useState("");
  const [fields, setFields] = useState({});
  const [busy, setBusy] = useState(false);
  const [suspended, setSuspended] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setFields({});
    const f = {};
    if (!form.email.trim()) f.email = "Enter your email address.";
    if (!form.password) f.password = "Enter your password.";
    if (Object.keys(f).length) return setFields(f);
    setBusy(true);
    try {
      const user = await login(form.email.trim(), form.password);
      toast.success(`Welcome back, ${user.name.split(" ")[0]}.`);
      const fallback = user.role === "admin" ? "/admin" : "/catalog";
      const from = location.state?.from;
      const safe =
        typeof from === "string" &&
        from.startsWith("/") &&
        !from.startsWith("//") &&
        Array.from(from).every(
          (c) => c.charCodeAt(0) > 32 && c.charCodeAt(0) !== 92,
        );
      navigate(safe ? from : fallback, { replace: true });
    } catch (err) {
      if (err.data?.suspended) {
        setSuspended({ ...err.data, message: err.message });
        return;
      }
      setError(err.message);
      setFields(err.fields || {});
    } finally {
      setBusy(false);
    }
  };

  if (suspended)
    return (
      <Suspended
        info={suspended}
        creds={{ email: form.email.trim(), password: form.password }}
        onBack={() => setSuspended(null)}
      />
    );

  return (
    <AuthFrame>
      <div className="auth-card panel panel-pad">
        <span className="eyebrow">YOUR READING SPACE</span>
        <h1>Welcome back.</h1>
        <p className="sub">Sign in to continue your next chapter.</p>
        <form
          onSubmit={submit}
          noValidate
          className="stack"
          style={{ "--gap": "16px" }}
        >
          {error && (
            <div className="alert alert-error" role="alert">
              <AlertCircle size={18} /> {error}
            </div>
          )}
          <Field label="Email" htmlFor="email" error={fields.email}>
            <input
              id="email"
              className="input"
              type="email"
              name="email"
              autoComplete="username"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              aria-invalid={!!fields.email || undefined}
            />
          </Field>
          <Field label="Password" htmlFor="password" error={fields.password}>
            <PasswordInput
              id="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              invalid={!!fields.password}
              autoComplete="current-password"
            />
          </Field>
          <button
            className="btn btn-primary btn-lg"
            style={{ width: "100%" }}
            disabled={busy}
          >
            {busy && <Loader2 size={18} className="spin" />} Sign in
          </button>
        </form>
        <p className="muted" style={{ marginTop: 18 }}>
          New here? <Link to="/register">Create an account</Link>
        </p>
        <p className="auth-privacy">
          <LockKeyhole size={15} /> Sign out when using a shared device.
        </p>
      </div>
    </AuthFrame>
  );
}

const RULES = [
  ["At least 15 characters", (p) => Array.from(p).length >= 15],
  [
    "At most 72 UTF-8 bytes",
    (p) => p.length > 0 && new TextEncoder().encode(p).length <= 72,
  ],
];

export function Register() {
  const { register } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    confirm: "",
  });
  const [error, setError] = useState("");
  const [fields, setFields] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const passed = RULES.filter(([, t]) => t(form.password)).length;

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setFields({});
    const f = {};
    if (form.name.trim().length < 2) f.name = "Enter your full name.";
    if (!/^\S+@\S+\.\S+$/.test(form.email.trim()))
      f.email = "Enter a valid email address.";
    if (passed < RULES.length)
      f.password =
        "Use a passphrase of at least 15 characters, up to 72 UTF-8 bytes.";
    if (form.confirm !== form.password)
      f.confirm = "The passwords don’t match.";
    if (Object.keys(f).length) return setFields(f);
    setBusy(true);
    try {
      const user = await register({
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
      });
      toast.success(`Welcome to Minerva, ${user.name.split(" ")[0]}.`);
      navigate("/catalog", { replace: true });
    } catch (err) {
      setError(err.message);
      setFields(err.fields || {});
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame>
      <div className="auth-card panel panel-pad">
        <h1>Create your account</h1>
        <p className="sub">Borrow books and keep track of due dates.</p>
        <form
          onSubmit={submit}
          noValidate
          className="stack"
          style={{ "--gap": "16px" }}
        >
          {error && (
            <div className="alert alert-error" role="alert">
              <AlertCircle size={18} /> {error}
            </div>
          )}
          <Field label="Full name" htmlFor="name" error={fields.name}>
            <input
              id="name"
              className="input"
              autoComplete="name"
              value={form.name}
              onChange={set("name")}
              aria-invalid={!!fields.name || undefined}
            />
          </Field>
          <Field label="Email" htmlFor="email" error={fields.email}>
            <input
              id="email"
              className="input"
              type="email"
              autoComplete="email"
              value={form.email}
              onChange={set("email")}
              aria-invalid={!!fields.email || undefined}
            />
          </Field>
          <Field label="Password" htmlFor="password" error={fields.password}>
            <PasswordInput
              id="password"
              value={form.password}
              onChange={set("password")}
              invalid={!!fields.password}
              autoComplete="new-password"
            />
            <div className="pw-meter" aria-hidden="true">
              {RULES.map((_, i) => (
                <i key={i} className={i < passed ? "on" : ""} />
              ))}
            </div>
            <span className="hint">
              {RULES.map(
                ([l, t]) => `${t(form.password) ? "✓" : "○"} ${l}`,
              ).join("   ")}
            </span>
          </Field>
          <Field
            label="Confirm password"
            htmlFor="confirm"
            error={fields.confirm}
          >
            <PasswordInput
              id="confirm"
              value={form.confirm}
              onChange={set("confirm")}
              invalid={!!fields.confirm}
              autoComplete="new-password"
            />
          </Field>
          <button
            className="btn btn-primary btn-lg"
            style={{ width: "100%" }}
            disabled={busy}
          >
            {busy && <Loader2 size={18} className="spin" />} Create account
          </button>
        </form>
        <p className="muted" style={{ marginTop: 18 }}>
          Already registered? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </AuthFrame>
  );
}
